import { assertRunScope, type AgentPlatform } from './platform.js'
import type { AgentRunRequest, AgentRunResult } from './runs.js'
import { agentStub } from './cloudflare-routing.js'
import { agentInstanceName, scheduleInstanceName, type AgentSchedule } from './scheduling.js'

/** The RPC surface of the Agent class that `createCloudflareAgent` produces. */
export interface CloudflareAgentRpc {
  start(request: AgentRunRequest): Promise<AgentRunResult>
  status(runId: string): Promise<AgentRunResult | null>
  resumeRun(payload: { runId: string }): Promise<void>
  /** Queue `resumeRun` on the Agent's own alarm and return. */
  continueRun(payload: { runId: string }): Promise<void>
  setSchedule(value: AgentSchedule | null): Promise<void>
  fireSchedule(payload: { generation: string; dueAt: string }): Promise<void>
}

/**
 * The agent platform on Cloudflare: each scope and each schedule key is its own
 * SQLite Agent instance behind one Durable Object binding. Importable from Node;
 * the Agents SDK loads only when a binding is called.
 */
export function cloudflareAgentPlatform(binding: unknown): AgentPlatform {
  return {
    async runs(scope) {
      const stub = await agentStub<CloudflareAgentRpc>(binding, await agentInstanceName(scope))
      return {
        start: async (request) => {
          assertRunScope(request, scope)
          return stub.start(request)
        },
        status: (runId) => stub.status(runId),
        resume: (runId) => stub.continueRun({ runId }),
      }
    },
    async schedule(key, value) {
      const stub = await agentStub<CloudflareAgentRpc>(binding, await scheduleInstanceName(key))
      await stub.setSchedule(value)
    },
  }
}
