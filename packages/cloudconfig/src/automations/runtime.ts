import {
  readDurableRecord,
  writeDurableRecord,
  withDurableLease,
  type DurableRecordStore,
} from '../durable/records.js'
import { automationDigest, automationRunKey } from './identity.js'
import {
  isAutomationTerminal,
  type AutomationContext,
  type AutomationHost,
  type AutomationIdentity,
  type AutomationResult,
  type AutomationRun,
  type AutomationStepOptions,
} from './types.js'

export interface StoredAutomation {
  kind: 'automation-run'
  revision: number
  request: AutomationRun
  result: AutomationResult
}

type Receipt =
  | { status: 'started'; attempt: number }
  | { status: 'completed'; value?: unknown }
  | { status: 'retrying'; attempt: number; wakeAt: string }
  | { status: 'sleeping'; wakeAt: string }

class AutomationYield extends Error {}
class AutomationWait extends Error {
  constructor(readonly waiting: { wakeAt?: string; waitingFor?: string }) {
    super('Waiting for automation continuation.')
  }
}
class AutomationCancelled extends Error {}

/** Portable replay of named checkpoints. Native adapters own durable continuation and clocks. */
export function automationRuntime<Env>(options: {
  host: AutomationHost<Env>
  records: DurableRecordStore
  env: Env
}) {
  const { host, records, env } = options
  async function stored(input: AutomationIdentity) {
    return readDurableRecord<StoredAutomation>(records, `${await automationRunKey(input)}:run`)
  }
  async function authorized(input: AutomationIdentity) {
    const run = await stored(input)
    if (!run) throw new Error('The automation run does not exist.')
    await host.authorize(run.request, { env, signal: AbortSignal.timeout(180_000) })
    return run
  }
  async function status(input: AutomationIdentity): Promise<AutomationResult | null> {
    return (await stored(input))?.result ?? null
  }

  return {
    async continuation(input: AutomationIdentity) {
      const run = await stored(input)
      if (!run) throw new Error('The automation run does not exist.')
      return { result: run.result, revision: run.revision }
    },
    async status(input: AutomationIdentity): Promise<AutomationResult | null> {
      const run = await stored(input)
      if (!run) return null
      await host.authorize(run.request, { env, signal: AbortSignal.timeout(180_000) })
      return run.result
    },
    async start(request: AutomationRun): Promise<AutomationResult> {
      const key = await automationRunKey(request)
      const existing = await stored(request)
      if (existing) return (await authorized(request)).result
      if (!Object.hasOwn(host.tasks, request.task)) {
        throw new Error(`Unknown automation task: ${request.task}`)
      }
      await host.authorize(request, { env, signal: AbortSignal.timeout(180_000) })
      const record: StoredAutomation = {
        kind: 'automation-run',
        revision: 0,
        request,
        result: { runId: request.runId, status: 'queued', output: null, error: '' },
      }
      await records.create(`${key}:run`, JSON.stringify(record))
      return (await authorized(request)).result
    },
    async signal(input: AutomationIdentity, event: string, payload: unknown): Promise<void> {
      validateName(event)
      const run = await authorized(input)
      if (isAutomationTerminal(run.result)) return
      await records.create(
        `${await automationRunKey(input)}:event:${event}`,
        JSON.stringify({ value: payload ?? null }),
      )
    },
    async cancel(input: AutomationIdentity): Promise<void> {
      await authorized(input)
      await writeDurableRecord<StoredAutomation>(
        records,
        `${await automationRunKey(input)}:run`,
        (run) => {
          if (!run) throw new Error('The automation run does not exist.')
          if (isAutomationTerminal(run.result)) return run
          return {
            ...run,
            result: { runId: input.runId, status: 'cancelled', output: null, error: '' },
          }
        },
      )
    },
    async tick(input: AutomationIdentity): Promise<AutomationResult> {
      const key = await automationRunKey(input)
      const outcome = await withDurableLease(records, key, async (assertOwner) => {
        const run = await stored(input)
        if (!run) throw new Error('The automation run does not exist.')
        if (isAutomationTerminal(run.result)) return run.result
        const signal = AbortSignal.timeout(180_000)
        const names = new Set<string>()
        let hasNewStep = false
        async function assertActive() {
          signal.throwIfAborted()
          await assertOwner()
          if ((await status(input))?.status === 'cancelled') throw new AutomationCancelled()
        }
        function claimName(name: string) {
          validateName(name)
          if (names.has(name)) {
            throw new Error(`Automation checkpoint names must be unique: ${name}`)
          }
          if (names.size >= 1000) {
            throw new Error('An automation may contain at most 1000 checkpoints.')
          }
          names.add(name)
        }
        async function saveReceipt(name: string, receipt: Receipt) {
          await assertActive()
          await writeDurableRecord<Receipt>(records, `${key}:step:${name}`, () => receipt)
        }
        const context: AutomationContext<Env> = {
          env,
          scope: input.scope,
          runId: input.runId,
          signal,
          async step(name, action, retry = {}) {
            claimName(name)
            const policy = stepPolicy(retry)
            const receipt = await readDurableRecord<Receipt>(records, `${key}:step:${name}`)
            if (receipt?.status === 'completed') {
              return receipt.value as Awaited<ReturnType<typeof action>>
            }
            if (receipt?.status === 'sleeping') {
              throw new Error(`Checkpoint ${name} changed its type.`)
            }
            if (receipt?.status === 'started' && !policy.idempotent) {
              throw new Error(
                `Step ${name} was interrupted after dispatch. Review its external result before starting another run.`,
              )
            }
            if (receipt?.status === 'retrying' && Date.parse(receipt.wakeAt) > Date.now()) {
              throw new AutomationWait({ wakeAt: receipt.wakeAt })
            }
            if (hasNewStep) throw new AutomationYield()
            const attempt = receipt ? receipt.attempt + 1 : 1
            if (attempt > policy.attempts) {
              throw new Error(`Step ${name} exhausted its retry attempts.`)
            }
            hasNewStep = true
            await saveReceipt(name, { status: 'started', attempt })
            try {
              const value = await action({
                idempotencyKey: `automation-${await automationDigest([key, name])}`,
                signal,
                attempt,
              })
              await saveReceipt(name, {
                status: 'completed',
                ...(value !== undefined ? { value } : {}),
              })
              return value
            } catch (cause) {
              if (cause instanceof AutomationCancelled) throw cause
              if (!policy.idempotent || attempt >= policy.attempts) throw cause
              const delay = Math.min(policy.retryDelayMs * 2 ** (attempt - 1), 3_600_000)
              const wakeAt = new Date(Date.now() + delay).toISOString()
              await saveReceipt(name, { status: 'retrying', attempt, wakeAt })
              throw new AutomationWait({ wakeAt })
            }
          },
          async sleep(name, milliseconds) {
            claimName(name)
            if (!Number.isFinite(milliseconds) || milliseconds < 0) {
              throw new Error('Automation sleep must be a non-negative number of milliseconds.')
            }
            const receipt = await readDurableRecord<Receipt>(records, `${key}:step:${name}`)
            if (receipt?.status === 'completed') return
            if (receipt && receipt.status !== 'sleeping') {
              throw new Error(`Checkpoint ${name} changed its type.`)
            }
            const wakeAt = receipt?.wakeAt ?? new Date(Date.now() + milliseconds).toISOString()
            if (!receipt) await saveReceipt(name, { status: 'sleeping', wakeAt })
            if (Date.parse(wakeAt) > Date.now()) throw new AutomationWait({ wakeAt })
            await saveReceipt(name, { status: 'completed', value: null })
          },
          async waitForEvent<T>(name: string): Promise<T> {
            claimName(name)
            const event = await readDurableRecord<{ value: T }>(records, `${key}:event:${name}`)
            if (event) return event.value
            throw new AutomationWait({ waitingFor: name })
          },
        }
        let result: AutomationResult = {
          runId: input.runId,
          status: 'running',
          output: null,
          error: '',
        }
        try {
          await assertActive()
          await host.authorize(run.request, { env, signal })
          await writeDurableRecord<StoredAutomation>(records, `${key}:run`, (current) => {
            if (!current) throw new Error('The automation run does not exist.')
            return current.result.status === 'cancelled' ? current : { ...current, result }
          })
          await assertActive()
          const task = Object.hasOwn(host.tasks, run.request.task)
            ? host.tasks[run.request.task]
            : undefined
          if (!task) throw new Error(`Unknown automation task: ${run.request.task}`)
          const output = await task(run.request.payload, context)
          result = { ...result, status: 'succeeded', output: output ?? null }
        } catch (cause) {
          if (cause instanceof AutomationCancelled) return (await status(input))!
          if (cause instanceof AutomationYield) result.status = 'queued'
          else if (cause instanceof AutomationWait) {
            result = { ...result, status: 'waiting', ...cause.waiting }
          } else {
            result = {
              ...result,
              status: 'failed',
              error: cause instanceof Error ? cause.message : 'Automation failed.',
            }
          }
        }
        await assertActive()
        return (
          await writeDurableRecord<StoredAutomation>(records, `${key}:run`, (current) => {
            if (!current) throw new Error('The automation run does not exist.')
            if (current.result.status === 'cancelled') return current
            return { ...current, revision: current.revision + 1, result }
          })
        ).result
      })
      const result = outcome ?? (await status(input))
      if (!result) throw new Error('The automation run does not exist.')
      return result
    },
  }
}

function validateName(name: string) {
  if (typeof name !== 'string' || !/^[\w .:-]{1,200}$/.test(name)) {
    throw new Error('Use a stable checkpoint/event name of 1–200 letters, digits, spaces or .:-_.')
  }
}

function stepPolicy(options: AutomationStepOptions) {
  const attempts = options.attempts ?? 1
  const retryDelayMs = options.retryDelayMs ?? 5000
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error('Automation step attempts must be between 1 and 10.')
  }
  if (attempts > 1 && !options.idempotent) {
    throw new Error('Retrying an automation step requires idempotent: true.')
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 3_600_000) {
    throw new Error('Automation retryDelayMs must be between 0 and 3600000.')
  }
  return { attempts, retryDelayMs, idempotent: options.idempotent === true }
}
