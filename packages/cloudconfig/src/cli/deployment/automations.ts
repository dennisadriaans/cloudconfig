import { generateSecret, upsertEnvValues } from '../auth-env.js'
import { ENV_FILE, resolveSecretValues } from '../cloudflare/secrets.js'
import { nextAgentSchedule } from '../../agents/scheduling.js'
import {
  automationSchedules,
  AUTOMATION_ADMIN_KEY,
  AUTOMATION_CONFIG_PATH,
} from '../../shared/automation-config.js'
import type { DeploymentRequest } from './ports.js'

/** Prepare the private control plane locally; dry runs never create credentials or contact a cloud. */
export function prepareAutomationDeployment(request: DeploymentRequest) {
  if (!request.config.deploy?.automations) return
  if (request.framework !== 'nuxt') {
    throw new Error(
      'Automatic automation deployment currently requires Nuxt. Other frameworks can compose the native automation adapters explicitly.',
    )
  }
  const schedules = automationSchedules(request.config)
  if (Object.keys(schedules).length > 100) {
    throw new Error('Declare at most 100 static automation schedules.')
  }
  for (const schedule of Object.values(schedules)) {
    nextAgentSchedule(schedule.cron, schedule.timeZone)
  }
  const { values } = resolveSecretValues(
    [AUTOMATION_ADMIN_KEY, 'VERCEL_AUTOMATION_BYPASS_SECRET'],
    request.projectDir,
  )
  let key = values[AUTOMATION_ADMIN_KEY]
  if (!key && !request.options.dryRun) {
    key = generateSecret()
    upsertEnvValues(request.projectDir, ENV_FILE, { [AUTOMATION_ADMIN_KEY]: key })
  }
  if (key && key.length < 32) {
    throw new Error(`${AUTOMATION_ADMIN_KEY} must contain at least 32 characters.`)
  }
  const env = key ? { [AUTOMATION_ADMIN_KEY]: key } : {}
  return {
    env,
    count: Object.keys(schedules).length,
    async configure(deploymentUrl: string): Promise<void> {
      if (request.options.dryRun) return
      const endpoint = new URL(AUTOMATION_CONFIG_PATH, deploymentUrl)
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
        throw new Error('The automation configuration endpoint must use HTTPS.')
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
      const bypass = values['VERCEL_AUTOMATION_BYPASS_SECRET']
      if (request.target === 'vercel' && bypass) headers['x-vercel-protection-bypass'] = bypass
      let failure: unknown
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            redirect: 'error',
            // Initializing many native timers can exceed an ordinary API request deadline.
            signal: AbortSignal.timeout(180_000),
          })
          await response.body?.cancel()
          if (response.ok) return
          failure = new Error(`The schedule control plane returned ${response.status}.`)
          if (response.status === 401 || response.status === 403) break
        } catch (cause) {
          failure = cause
        }
      }
      throw new Error(
        `The app was published at ${deploymentUrl}, but automation schedules were not synchronized. Check startup logs and ${AUTOMATION_ADMIN_KEY}; protected Vercel projects also need VERCEL_AUTOMATION_BYPASS_SECRET. Retry cloudconfig deploy.`,
        { cause: failure },
      )
    },
  }
}
