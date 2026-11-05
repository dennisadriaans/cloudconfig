import type { AgentRunHost } from './runs.js'
import { registerAzureWorkloads } from '../durable/azure.js'
export {
  azureAgentRun,
  azureAgentSchedule,
  type AgentOrchestrationContext,
} from '../durable/azure.js'
export function registerAzureAgents(host: AgentRunHost<NodeJS.ProcessEnv>): void {
  registerAzureWorkloads({ agent: host })
}
