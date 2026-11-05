import type { DurableRecordStore } from '../durable/records.js'
import {
  automationService,
  type AutomationDispatcher,
  type AutomationScheduleIdentity,
} from './service.js'
import {
  isAutomationTerminal,
  type AutomationHost,
  type AutomationIdentity,
  type AutomationPlatform,
} from './types.js'

export * from './types.js'
const REGISTRY = Symbol.for('cloudconfig.automationPlatform')
type Factory = (env: Record<string, unknown> | undefined) => AutomationPlatform
type Registry = { [REGISTRY]?: Factory | undefined }

export function provideAutomationPlatform(factory: Factory | undefined): void {
  ;(globalThis as Registry)[REGISTRY] = factory
}
export function getAutomationPlatform(
  env?: Record<string, unknown>,
): AutomationPlatform | undefined {
  return (globalThis as Registry)[REGISTRY]?.(env)
}

/** Development only. Native adapters keep the same contracts with durable storage and timers. */
export function createMemoryAutomationPlatform<Env>(
  host: AutomationHost<Env>,
  options: {
    env: Env
    onError?: (cause: unknown) => void
  },
): AutomationPlatform {
  const values = new Map<string, { value: string; version: string }>()
  const records: DurableRecordStore = {
    async read(key) {
      return structuredClone(values.get(key) ?? null)
    },
    async create(key, value) {
      if (values.has(key)) return false
      values.set(key, { value, version: crypto.randomUUID() })
      return true
    },
    async replace(key, value, version) {
      if (values.get(key)?.version !== version) return false
      values.set(key, { value, version: crypto.randomUUID() })
      return true
    },
  }
  const active = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; wake: () => Promise<void> }
  >()
  const report = options.onError ?? ((cause) => console.error('[cloudconfig] automation:', cause))
  function arm(id: string, dueAt: number) {
    const execution = active.get(id)
    if (!execution) return
    if (execution.timer) clearTimeout(execution.timer)
    execution.timer = setTimeout(
      () => {
        if (Date.now() < dueAt) return arm(id, dueAt)
        void execution.wake().catch((cause) => {
          report(cause)
          arm(id, Date.now() + 5000)
        })
      },
      Math.min(Math.max(0, dueAt - Date.now()), 2_147_483_647),
    )
    ;(execution.timer as { unref?: () => void }).unref?.()
  }
  const dispatcher: AutomationDispatcher = {
    async startRun(input: AutomationIdentity) {
      const id = crypto.randomUUID()
      active.set(id, {
        async wake() {
          const result = await service.runtime.tick(input)
          if (isAutomationTerminal(result)) active.delete(id)
          else if (result.status !== 'waiting' || result.wakeAt) {
            arm(id, result.wakeAt ? Date.parse(result.wakeAt) : Date.now() + 1)
          }
        },
      })
      arm(id, Date.now())
      return id
    },
    async startSchedule(input: AutomationScheduleIdentity) {
      const id = crypto.randomUUID()
      active.set(id, {
        async wake() {
          const current = await service.schedule(input)
          if (!current?.dueAt) {
            active.delete(id)
            return
          }
          if (Date.parse(current.dueAt) <= Date.now()) {
            await service.fire({ ...input, dueAt: current.dueAt })
          }
          const next = await service.schedule(input)
          if (next?.dueAt) arm(id, Date.parse(next.dueAt))
          else active.delete(id)
        },
      })
      const current = await service.schedule(input)
      if (current?.dueAt) arm(id, Date.parse(current.dueAt))
      return id
    },
    async isActive(id) {
      return active.has(id)
    },
    async wake(id) {
      arm(id, Date.now())
    },
    async cancel(id) {
      const current = active.get(id)
      if (current?.timer) clearTimeout(current.timer)
      active.delete(id)
    },
  }
  const service = automationService({ host, env: options.env, records, dispatcher })
  return service.platform
}
