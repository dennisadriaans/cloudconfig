import type { AnyConfig } from '../dsl/model-config.js'
import type { AutomationSchedule } from '../automations/types.js'

export const AUTOMATION_ADMIN_KEY = 'CLOUDCONFIG_AUTOMATION_ADMIN_KEY'
export const AUTOMATION_CONFIG_PATH = '/_cloudconfig/automations/configure'
export const CONNECT_MAINTENANCE_TASK = 'cloudconfig.connect.maintain'
export const CONNECT_MAINTENANCE_SCHEDULE = 'cloudconfig:connect-maintenance'

/** Pure config derivation; safe to import with the DSL without pulling a runtime into the browser. */
export function automationSchedules(config: AnyConfig): Record<string, AutomationSchedule> {
  const schedules = { ...config.deploy?.automations?.schedules }
  if (!config.deploy?.automations || !config.connect || config.connect.maintenance === false) {
    return schedules
  }
  if (Object.hasOwn(schedules, CONNECT_MAINTENANCE_SCHEDULE)) {
    throw new Error(`${CONNECT_MAINTENANCE_SCHEDULE} is reserved for Connect housekeeping.`)
  }
  const options = config.connect.maintenance
  schedules[CONNECT_MAINTENANCE_SCHEDULE] = {
    cron: options?.cron ?? '*/5 * * * *',
    timeZone: options?.timeZone ?? 'UTC',
    run: {
      task: CONNECT_MAINTENANCE_TASK,
      scope: { ownerId: null, workspace: 'cloudconfig:system' },
      payload: { limit: options?.limit ?? 50 },
    },
  }
  return schedules
}
