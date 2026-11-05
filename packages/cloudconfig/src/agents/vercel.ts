import { getRun, start } from 'workflow/api'
import type { AnyConfig } from '../dsl/model-config.js'
import type { AgentRunHost } from './runs.js'
import type { AgentPlatform } from './platform.js'
import { databaseAgentRecords } from './database-records.js'
import {
  createDurableAgentPlatform,
  durableAgentRuntime,
  type NativeAgentRun,
  type NativeAgentSchedule,
} from './durable.js'

export interface VercelAgentWorkflows {
  run(input: NativeAgentRun): Promise<unknown>
  schedule(input: NativeAgentSchedule): Promise<unknown>
}

/** Workflow functions are generated in the consumer app so the official compiler can transform them. */
export function vercelAgentPlatform(options: {
  host: AgentRunHost<NodeJS.ProcessEnv>
  config: AnyConfig
  workflows: VercelAgentWorkflows
}): AgentPlatform {
  return createDurableAgentPlatform({
    host: options.host,
    env: process.env,
    records: databaseAgentRecords(options.config),
    dispatcher: {
      startRun: async (input) => (await start(options.workflows.run, [input])).runId,
      startSchedule: async (input) => (await start(options.workflows.schedule, [input])).runId,
      async isActive(id) {
        const run = getRun(id)
        if (!(await run.exists)) return false
        const status = await run.status
        return status === 'pending' || status === 'running'
      },
      async wake(id) {
        await getRun(id).wakeUp()
      },
      async cancel(id) {
        const run = getRun(id)
        if ((await run.exists) && ['pending', 'running'].includes(await run.status)) {
          await run.cancel()
        }
      },
    },
  })
}

/** Called only inside generated Workflow steps; secrets never enter workflow arguments or history. */
export function vercelAgentRuntime(host: AgentRunHost<NodeJS.ProcessEnv>, config: AnyConfig) {
  return durableAgentRuntime({ host, env: process.env, records: databaseAgentRecords(config) })
}
