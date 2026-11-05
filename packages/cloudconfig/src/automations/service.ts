import { nextAgentSchedule } from '../agents/scheduling.js'
import { ensureDurableExecution, type DurableDispatcher } from '../durable/dispatcher.js'
import {
  readDurableRecord,
  withDurableLease,
  writeDurableRecord,
  type DurableRecordStore,
} from '../durable/records.js'
import { assertAutomationScope, automationDigest, automationRunKey } from './identity.js'
import { automationRuntime } from './runtime.js'
import {
  isAutomationTerminal,
  type AutomationHost,
  type AutomationIdentity,
  type AutomationPlatform,
  type AutomationSchedule,
  type AutomationRun,
  type AutomationResult,
} from './types.js'

export interface AutomationScheduleIdentity {
  key: string
  generation: string
}
export interface AutomationScheduleTick extends AutomationScheduleIdentity {
  dueAt: string
}
export interface StoredAutomationSchedule extends AutomationScheduleIdentity {
  kind: 'automation-schedule'
  value: AutomationSchedule | null
  dueAt: string | null
  executionId?: string
}
export type AutomationDispatcher = DurableDispatcher<AutomationIdentity, AutomationScheduleIdentity>

async function scheduleKey(key: string) {
  if (typeof key !== 'string' || !key || key.length > 500) {
    throw new Error('Use a stable automation schedule key.')
  }
  return `cloudconfig-automation-schedule-${await automationDigest(key)}`
}

/** Shared control plane for native workflows; it never executes a task inside an accepting request. */
export function automationService<Env>(options: {
  host: AutomationHost<Env>
  records: DurableRecordStore
  env: Env
  dispatcher: AutomationDispatcher
  /** Cloudflare routes scheduled runs to their scope's Durable Object. */
  enqueue?: (request: AutomationRun) => Promise<AutomationResult>
}) {
  const { records, dispatcher } = options
  const runtime = automationRuntime(options)

  async function ensureRun(input: AutomationIdentity, shouldWake: boolean) {
    await ensureDurableExecution({
      records,
      key: `${await automationRunKey(input)}:execution`,
      start: () => dispatcher.startRun(input),
      isActive: (id) => dispatcher.isActive(id),
      ...(shouldWake ? { wake: (id: string) => dispatcher.wake(id) } : {}),
    })
  }

  const platform: AutomationPlatform = {
    async runs(scope) {
      return {
        async start(request) {
          assertAutomationScope(request, scope)
          const result = await runtime.start(request)
          if (!isAutomationTerminal(result)) await ensureRun(request, false)
          return result
        },
        status: (runId) => runtime.status({ scope, runId }),
        async resume(runId) {
          const input = { scope, runId }
          const result = await runtime.status(input)
          if (!result) throw new Error('The automation run does not exist.')
          if (!isAutomationTerminal(result)) await ensureRun(input, true)
        },
        async signal(runId, event, payload) {
          const input = { scope, runId }
          await runtime.signal(input, event, payload)
          const result = await runtime.status(input)
          if (result && !isAutomationTerminal(result)) await ensureRun(input, true)
        },
        async cancel(runId) {
          const input = { scope, runId }
          await runtime.cancel(input)
          const execution = await readDurableRecord<{ id: string }>(
            records,
            `${await automationRunKey(input)}:execution`,
          )
          if (execution) await dispatcher.cancel(execution.id)
        },
      }
    },
    async schedule(key, value) {
      if (value) {
        await automationRunKey({ scope: value.run.scope, runId: 'schedule-validation' })
        if (!Object.hasOwn(options.host.tasks, value.run.task)) {
          throw new Error(`Unknown automation task: ${value.run.task}`)
        }
        await options.host.authorize(
          { ...value.run, runId: 'schedule-validation' },
          {
            env: options.env,
            signal: AbortSignal.timeout(180_000),
          },
        )
      }
      const storageKey = await scheduleKey(key)
      const accepted = await withDurableLease(records, storageKey, async () => {
        const previous = await readDurableRecord<StoredAutomationSchedule>(records, storageKey)
        const hasSameValue = !!previous && JSON.stringify(previous.value) === JSON.stringify(value)
        if (
          hasSameValue &&
          (!value || (previous.executionId && (await dispatcher.isActive(previous.executionId))))
        ) {
          return true
        }
        const schedule: StoredAutomationSchedule = hasSameValue
          ? previous
          : {
              kind: 'automation-schedule',
              key,
              generation: crypto.randomUUID(),
              value,
              dueAt: value ? nextAgentSchedule(value.cron, value.timeZone).toISOString() : null,
            }
        await writeDurableRecord<StoredAutomationSchedule>(records, storageKey, () => schedule)
        if (!hasSameValue && previous?.executionId) await dispatcher.cancel(previous.executionId)
        if (!value) return true
        const id = await dispatcher.startSchedule({ key, generation: schedule.generation })
        await trackSchedule(schedule, id, schedule.dueAt)
        return true
      })
      if (!accepted) {
        throw new Error(
          'Another request is changing this automation schedule. Retry the operation.',
        )
      }
    },
    async configure(schedules) {
      if (Object.keys(schedules).length > 100) {
        throw new Error('Declare at most 100 static automation schedules.')
      }
      const key = 'cloudconfig:automations:configuration'
      const accepted = await withDurableLease(records, key, async () => {
        const previous = await readDurableRecord<{ keys: string[] }>(records, key)
        const keys = Object.keys(schedules)
        for (const name of previous?.keys ?? []) {
          if (!Object.hasOwn(schedules, name)) await platform.schedule(`static:${name}`, null)
        }
        for (const [name, schedule] of Object.entries(schedules)) {
          await platform.schedule(`static:${name}`, schedule)
        }
        await writeDurableRecord(records, key, () => ({ keys }))
        return true
      })
      if (!accepted) {
        throw new Error('Another deployment is configuring automation schedules. Retry deployment.')
      }
    },
  }

  async function schedule(
    input: AutomationScheduleIdentity,
  ): Promise<StoredAutomationSchedule | null> {
    const current = await readDurableRecord<StoredAutomationSchedule>(
      records,
      await scheduleKey(input.key),
    )
    return current?.generation === input.generation && current.value ? current : null
  }
  async function trackSchedule(
    input: AutomationScheduleIdentity,
    id: string,
    dueAt: string | null,
  ) {
    await writeDurableRecord<StoredAutomationSchedule>(
      records,
      await scheduleKey(input.key),
      (current) => {
        if (!current) throw new Error('The automation schedule does not exist.')
        if (current.generation !== input.generation || current.dueAt !== dueAt || !current.value) {
          return current
        }
        return { ...current, executionId: id }
      },
    )
  }
  async function fire(input: AutomationScheduleTick): Promise<void> {
    const key = await scheduleKey(input.key)
    const accepted = await withDurableLease(records, key, async () => {
      const current = await schedule(input)
      if (
        !current?.value ||
        current.dueAt !== input.dueAt ||
        Date.parse(input.dueAt) > Date.now()
      ) {
        return true
      }
      const runId = `scheduled_${await automationDigest([input.key, input.generation, input.dueAt])}`
      // Repeating this enqueue is safe: the stable run ID persists before native dispatch.
      const request = { ...current.value.run, runId }
      if (options.enqueue) await options.enqueue(request)
      else await (await platform.runs(request.scope)).start(request)
      await writeDurableRecord<StoredAutomationSchedule>(records, key, (latest) => {
        if (!latest) throw new Error('The automation schedule does not exist.')
        if (latest.generation !== input.generation || latest.dueAt !== input.dueAt) return latest
        const after = new Date(Math.max(Date.now(), Date.parse(input.dueAt)))
        return {
          ...latest,
          dueAt: nextAgentSchedule(
            current.value!.cron,
            current.value!.timeZone,
            after,
          ).toISOString(),
        }
      })
      return true
    })
    if (!accepted) {
      throw new Error('Another activity is changing this automation schedule. Retry the activity.')
    }
  }
  return { platform, runtime, schedule, trackSchedule, fire }
}
