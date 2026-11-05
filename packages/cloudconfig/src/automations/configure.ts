import type { AnyConfig } from '../dsl/model-config.js'
import { timingSafeEqual } from '../connect/crypto.js'
import { readEnv } from '../server/auth/env.js'
import { automationSchedules, AUTOMATION_ADMIN_KEY } from '../shared/automation-config.js'
import { getAutomationPlatform } from './platform.js'

/** Deployment may synchronize config-declared schedules, never submit arbitrary task payloads. */
export async function configureAutomationRequest(
  config: AnyConfig,
  request: Request,
  env?: Record<string, unknown>,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }
  const expected = readEnv(AUTOMATION_ADMIN_KEY, env)
  if (!expected) {
    return Response.json({ error: 'Automation deployment is not configured.' }, { status: 503 })
  }
  const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!presented || !timingSafeEqual(presented, expected)) {
    return new Response(null, { status: 401 })
  }
  const platform = getAutomationPlatform(env)
  if (!platform) {
    return Response.json({ error: 'The automation runtime is not bound.' }, { status: 503 })
  }
  const schedules = automationSchedules(config)
  await platform.configure(schedules)
  return Response.json({ schedules: Object.keys(schedules) })
}
