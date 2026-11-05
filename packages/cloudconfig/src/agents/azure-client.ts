import type { AgentPlatform } from './platform.js'
import { assertRunScope } from './platform.js'
import { azureDurableCommand } from '../durable/azure-client.js'

export const AZURE_AGENT_ENDPOINT = 'CLOUDCONFIG_AZURE_AGENT_ENDPOINT'
export const AZURE_AGENT_KEY = 'CLOUDCONFIG_AZURE_AGENT_KEY'

/** Server-to-server client. The authenticated application gateway remains the owner boundary. */
export function azureAgentPlatform(env?: Record<string, unknown>): AgentPlatform {
  const call = <T>(action: string, input: unknown) =>
    azureDurableCommand<T>({ env, endpointEnv: AZURE_AGENT_ENDPOINT, action, input })
  return {
    async runs(scope) {
      return {
        start: async (request) => {
          assertRunScope(request, scope)
          return call('start', request)
        },
        status: (runId) => call('status', { scope, runId }),
        resume: (runId) => call('resume', { scope, runId }),
      }
    },
    schedule: (key, value) => call('schedule', { key, value }),
  }
}
