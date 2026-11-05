import type { DeploymentTarget } from '../dsl/model-config.js'

/** Fail closed for JS configs too: a typo must never deploy to the default account. */
export function resolveDeploymentTarget(target: unknown): DeploymentTarget {
  if (target === undefined) return 'cloudflare'
  if (target === 'cloudflare' || target === 'vercel' || target === 'azure') return target
  throw new Error(
    `Unknown deploy.target "${String(target)}". Expected cloudflare, vercel or azure.`,
  )
}

export function deploymentPreset(target: DeploymentTarget): string {
  if (target === 'cloudflare') return 'cloudflare_module'
  if (target === 'vercel') return 'vercel'
  return 'node-server'
}
