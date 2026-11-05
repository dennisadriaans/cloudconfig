import { getRun, start } from 'workflow/api'
import type { AnyConfig } from '../dsl/model-config.js'
import { databaseExecutionRecords } from '../durable/database-records.js'
import { automationService, type AutomationScheduleIdentity } from './service.js'
import type { AutomationHost, AutomationIdentity } from './types.js'

export interface VercelAutomationWorkflows {
  run(input: AutomationIdentity): Promise<unknown>
  schedule(input: AutomationScheduleIdentity): Promise<unknown>
}
export function vercelAutomationService(options: {
  host: AutomationHost<NodeJS.ProcessEnv>
  config: AnyConfig
  workflows: VercelAutomationWorkflows
}) {
  return automationService({
    host: options.host,
    env: process.env,
    records: databaseExecutionRecords(options.config),
    dispatcher: {
      startRun: async (input) => (await start(options.workflows.run, [input])).runId,
      startSchedule: async (input) => (await start(options.workflows.schedule, [input])).runId,
      async isActive(id) {
        const run = getRun(id)
        return (await run.exists) && ['pending', 'running'].includes(await run.status)
      },
      wake: async (id) => {
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
