import { join } from 'node:path'
import { readWranglerFile } from '../../cloudflare/wrangler-config.js'
import { ensureTurnstile, planTurnstile, TURNSTILE_SECRET } from '../../cloudflare/turnstile.js'
import type { DeploymentRequest } from '../ports.js'

/** Turnstile stays on Cloudflare even when application hosting moves. */
export function prepareTurnstileDeployment(
  request: DeploymentRequest,
): (() => Promise<Record<string, string>>) | undefined {
  const deploy = request.config.deploy
  if (!deploy?.turnstile) return
  const file = readWranglerFile(request.projectDir) ?? {
    path: join(request.projectDir, 'wrangler.jsonc'),
    text: '{}',
    format: 'json' as const,
  }
  const plan = planTurnstile(request.projectDir, file, deploy)
  if (!plan) return
  return async () => {
    const result = await ensureTurnstile(
      { projectDir: request.projectDir, file, workerName: deploy.worker ?? request.name },
      plan,
      false,
    )
    return { ...result.buildEnv, ...(result.secret ? { [TURNSTILE_SECRET]: result.secret } : {}) }
  }
}
