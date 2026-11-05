import { azureDurableCommand } from '../durable/azure-client.js'
import { assertAutomationScope } from './identity.js'
import type { AutomationPlatform } from './types.js'

export const AZURE_AUTOMATION_ENDPOINT = 'CLOUDCONFIG_AZURE_AUTOMATION_ENDPOINT'

export function azureAutomationPlatform(env?: Record<string, unknown>): AutomationPlatform {
  const call = <T>(action: string, input: unknown) =>
    azureDurableCommand<T>({ env, endpointEnv: AZURE_AUTOMATION_ENDPOINT, action, input })
  return {
    async runs(scope) {
      return {
        async start(request) {
          assertAutomationScope(request, scope)
          return call('start', request)
        },
        status: (runId) => call('status', { scope, runId }),
        resume: (runId) => call('resume', { scope, runId }),
        signal: (runId, event, payload) => call('signal', { scope, runId, event, payload }),
        cancel: (runId) => call('cancel', { scope, runId }),
      }
    },
    schedule: (key, value) => call('schedule', { key, value }),
    configure: (schedules) =>
      azureDurableCommand({
        env,
        endpointEnv: AZURE_AUTOMATION_ENDPOINT,
        action: 'configure',
        input: { schedules },
        timeoutMs: 180_000,
      }),
  }
}
