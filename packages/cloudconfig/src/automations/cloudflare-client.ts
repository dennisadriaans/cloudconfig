import { agentStub } from '../agents/cloudflare-routing.js'
import { assertAutomationScope, automationDigest, automationInstance } from './identity.js'
import type {
  AutomationIdentity,
  AutomationPlatform,
  AutomationResult,
  AutomationRun,
  AutomationSchedule,
} from './types.js'

export interface CloudflareAutomationRpc {
  start(request: AutomationRun): Promise<AutomationResult>
  status(input: AutomationIdentity): Promise<AutomationResult | null>
  resume(input: AutomationIdentity): Promise<void>
  signal(input: AutomationIdentity & { event: string; payload: unknown }): Promise<void>
  cancel(input: AutomationIdentity): Promise<void>
  setSchedule(input: { key: string; value: AutomationSchedule | null }): Promise<void>
  configure(schedules: Record<string, AutomationSchedule>): Promise<void>
}

export function cloudflareAutomationPlatform(binding: unknown): AutomationPlatform {
  return {
    async runs(scope) {
      const stub = await agentStub<CloudflareAutomationRpc>(
        binding,
        await automationInstance(scope),
      )
      return {
        async start(request) {
          assertAutomationScope(request, scope)
          return stub.start(request)
        },
        status: (runId) => stub.status({ scope, runId }),
        resume: (runId) => stub.resume({ scope, runId }),
        signal: (runId, event, payload) => stub.signal({ scope, runId, event, payload }),
        cancel: (runId) => stub.cancel({ scope, runId }),
      }
    },
    async schedule(key, value) {
      const name = `cloudconfig-automation-schedule-${await automationDigest(key)}`
      const stub = await agentStub<CloudflareAutomationRpc>(binding, name)
      await stub.setSchedule({ key, value })
    },
    async configure(schedules) {
      const stub = await agentStub<CloudflareAutomationRpc>(
        binding,
        'cloudconfig-automation-configuration',
      )
      await stub.configure(schedules)
    },
  }
}
