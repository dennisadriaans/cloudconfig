import type { AutomationHost } from './types.js'
import { registerAzureWorkloads } from '../durable/azure.js'
export { azureAutomationRun, azureAutomationSchedule } from '../durable/azure.js'
export function registerAzureAutomations(host: AutomationHost<NodeJS.ProcessEnv>): void {
  registerAzureWorkloads({ automations: host })
}
