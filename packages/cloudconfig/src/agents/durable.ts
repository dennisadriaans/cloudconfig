import { assertRunScope, type AgentPlatform } from './platform.js'
import {
  createAgentRunner,
  type AgentRunHost,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunStore,
  type AgentReceipt,
  type StoredAgentRun,
} from './runs.js'
import {
  agentInstanceName,
  nextAgentSchedule,
  scheduleInstanceName,
  type AgentScope,
  type AgentSchedule,
} from './scheduling.js'
import {
  readAgentRecord,
  writeAgentRecord,
  withAgentLease,
  type AgentRecordStore,
} from './records.js'
import { ensureDurableExecution, type DurableDispatcher } from '../durable/dispatcher.js'

export interface NativeAgentRun {
  scope: AgentScope
  runId: string
}
export interface NativeAgentSchedule {
  key: string
  generation: string
}
export interface NativeAgentScheduleTick extends NativeAgentSchedule {
  dueAt: string
}
export interface DurableSchedule extends NativeAgentSchedule {
  value: AgentSchedule | null
  dueAt: string | null
  executionId?: string
}
export type NativeAgentDispatcher = DurableDispatcher<NativeAgentRun, NativeAgentSchedule>

async function runKey({ scope, runId }: NativeAgentRun) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new Error('Use a valid run ID.')
  return `${await agentInstanceName(scope)}:${runId}`
}

export function durableAgentRuntime<Env>(options: {
  host: AgentRunHost<Env>
  records: AgentRecordStore
  env: Env
}) {
  const { host, records, env } = options

  function runStore(key: string, assertOwner: () => Promise<void> = async () => {}): AgentRunStore {
    return {
      run: () => readAgentRecord<StoredAgentRun>(records, `${key}:run`),
      async insert(run) {
        await records.create(`${key}:run`, JSON.stringify(run))
      },
      async update(result) {
        await assertOwner()
        await writeAgentRecord<StoredAgentRun>(records, `${key}:run`, (run) => {
          if (!run) throw new Error('The agent run does not exist.')
          return { ...run, result }
        })
      },
      receipt: (_runId, name) => readAgentRecord<AgentReceipt>(records, `${key}:receipt:${name}`),
      async setReceipt(_runId, name, receipt) {
        await assertOwner()
        await writeAgentRecord<AgentReceipt>(records, `${key}:receipt:${name}`, () => receipt)
      },
    }
  }

  async function status(input: NativeAgentRun): Promise<AgentRunResult | null> {
    return (await runStore(await runKey(input)).run(input.runId))?.result ?? null
  }

  return {
    status,
    async start(request: AgentRunRequest) {
      const runner = createAgentRunner({
        host,
        env,
        store: runStore(await runKey(request)),
        dispatch: () => {},
      })
      return runner.start(request)
    },
    async tick(input: NativeAgentRun): Promise<AgentRunResult> {
      const key = await runKey(input)
      const result = await withAgentLease(records, key, async (assertOwner) => {
        const runner = createAgentRunner({
          host,
          env,
          store: runStore(key, assertOwner),
          dispatch: () => {},
          maxSteps: 1,
          timeoutMs: 120_000,
          signal: AbortSignal.timeout(180_000),
        })
        await runner.resume(input.runId)
        return runner.status(input.runId)
      })
      const current = result ?? (await status(input))
      if (!current) throw new Error('The agent run does not exist.')
      return current
    },
    async replaceSchedule(key: string, value: AgentSchedule | null): Promise<DurableSchedule> {
      if (value && !host.scheduled) {
        throw new Error('The agent host must implement scheduled() before scheduling runs.')
      }
      const dueAt = value ? nextAgentSchedule(value.cron, value.timeZone).toISOString() : null
      const schedule: DurableSchedule = { key, value, dueAt, generation: crypto.randomUUID() }
      await writeAgentRecord<DurableSchedule>(
        records,
        await scheduleInstanceName(key),
        () => schedule,
      )
      return schedule
    },
    async schedule(input: NativeAgentSchedule): Promise<DurableSchedule | null> {
      const current = await readAgentRecord<DurableSchedule>(
        records,
        await scheduleInstanceName(input.key),
      )
      return current?.generation === input.generation && current.value ? current : null
    },
    async trackSchedule(
      input: NativeAgentSchedule,
      id: string,
      dueAt: string | null,
    ): Promise<void> {
      await writeAgentRecord<DurableSchedule>(
        records,
        await scheduleInstanceName(input.key),
        (current) => {
          if (!current) throw new Error('The schedule does not exist.')
          if (
            current.generation !== input.generation ||
            !current.value ||
            current.dueAt !== dueAt
          ) {
            return current
          }
          return { ...current, executionId: id }
        },
      )
    },
    async fire(input: NativeAgentScheduleTick): Promise<void> {
      const key = await scheduleInstanceName(input.key)
      const outcome = await withAgentLease(records, key, async (assertOwner) => {
        const current = await readAgentRecord<DurableSchedule>(records, key)
        if (
          !current?.value ||
          current.generation !== input.generation ||
          current.dueAt !== input.dueAt
        ) {
          return true
        }
        if (new Date(current.dueAt).getTime() > Date.now()) return true
        if (!host.scheduled) {
          throw new Error('The agent host must implement scheduled() before executing schedules.')
        }
        const receiptKey = `${key}:tick:${current.generation}:${current.dueAt}`
        const claimed = await records.create(receiptKey, JSON.stringify({ status: 'started' }))
        if (!claimed) {
          const receipt = await readAgentRecord<{ status: string }>(records, receiptKey)
          if (receipt?.status !== 'completed') {
            throw new Error(
              'A scheduled action was interrupted. Review its external result before enabling the schedule again.',
            )
          }
        } else {
          await host.scheduled(current.value.payload, current.dueAt, env)
          await assertOwner()
          await writeAgentRecord(records, receiptKey, () => ({ status: 'completed' }))
        }
        await assertOwner()
        await writeAgentRecord<DurableSchedule>(records, key, (latest) => {
          if (!latest) throw new Error('The schedule does not exist.')
          if (latest.generation !== current.generation) return latest
          return {
            ...latest,
            dueAt: nextAgentSchedule(current.value!.cron, current.value!.timeZone).toISOString(),
          }
        })
        return true
      })
      if (!outcome) {
        throw new Error('Another activity is updating this schedule. Retry the activity.')
      }
    },
  }
}

/** Native workflows own continuation; this port owns identity, persisted receipts and scope checks. */
export function createDurableAgentPlatform<Env>(options: {
  host: AgentRunHost<Env>
  env: Env
  records: AgentRecordStore
  dispatcher: NativeAgentDispatcher
}): AgentPlatform {
  const { records, dispatcher } = options
  const runtime = durableAgentRuntime(options)
  async function ensureRun(input: NativeAgentRun, wake: boolean) {
    await ensureDurableExecution({
      records,
      key: `${await runKey(input)}:execution`,
      start: () => dispatcher.startRun(input),
      isActive: (id) => dispatcher.isActive(id),
      ...(wake ? { wake: (id: string) => dispatcher.wake(id) } : {}),
    })
  }
  return {
    async runs(scope) {
      return {
        async start(request) {
          assertRunScope(request, scope)
          const result = await runtime.start(request)
          if (result.status !== 'succeeded' && result.status !== 'failed') {
            await ensureRun(request, false)
          }
          return result
        },
        status: (runId) => runtime.status({ scope, runId }),
        async resume(runId) {
          const input = { scope, runId }
          const current = await runtime.status(input)
          if (!current) throw new Error('The agent run does not exist.')
          if (current.status !== 'succeeded' && current.status !== 'failed') {
            await ensureRun(input, true)
          }
        },
      }
    },
    async schedule(key, value) {
      const previous = await readAgentRecord<DurableSchedule>(
        records,
        await scheduleInstanceName(key),
      )
      const schedule = await runtime.replaceSchedule(key, value)
      if (previous?.executionId) await dispatcher.cancel(previous.executionId)
      if (!value) return
      const id = await dispatcher.startSchedule({ key, generation: schedule.generation })
      await runtime.trackSchedule(schedule, id, schedule.dueAt)
    },
  }
}
