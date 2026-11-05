import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { AnyConfig } from '../dsl/model-config.js'
import { automationSchedules } from '../shared/automation-config.js'
import { workerExports } from '../shared/worker-exports.js'
import { nextAgentSchedule } from '../agents/scheduling.js'
import type { Framework } from './detect.js'
import type { DoctorCheck } from './doctor.js'

const RUNTIME_PACKAGES = {
  cloudflare: ['agents'],
  vercel: ['workflow'],
  azure: ['@azure/functions', 'durable-functions', '@azure/storage-blob'],
} as const

/** Check declared features and optional SDKs without importing a cloud SDK or contacting a provider. */
export function workloadChecks(options: {
  config: AnyConfig
  projectDir: string
  framework: Framework
  hasRuntimePackage?: (name: string) => boolean
}): DoctorCheck[] {
  const { config, projectDir, framework } = options
  const target = config.deploy?.target ?? 'cloudflare'
  const checks: DoctorCheck[] = []
  try {
    const declarations = workerExports(config.deploy)
    for (const declaration of declarations) {
      const hasEntry = existsSync(join(projectDir, declaration.entry))
      checks.push({
        id: 'workload-entry',
        label: 'Durable workload',
        status: hasEntry ? 'ok' : 'fail',
        detail: hasEntry ? declaration.entry : `Missing deployment entry: ${declaration.entry}`,
      })
    }
    if (config.deploy?.workflows?.length && target !== 'cloudflare') {
      throw new Error(
        'Cloudflare Workflow classes require Cloudflare. Use deploy.automations for portable tasks.',
      )
    }
    const hasNativeHost = !!(
      config.deploy?.agent ||
      config.deploy?.agents?.length ||
      config.deploy?.automations
    )
    if (hasNativeHost) {
      const peers = RUNTIME_PACKAGES[target]
      const require = createRequire(join(projectDir, 'package.json'))
      const hasPackage =
        options.hasRuntimePackage ??
        ((peer: string) => {
          try {
            require.resolve(peer)
            return true
          } catch {
            return false
          }
        })
      const missing = peers.filter((peer) => !hasPackage(peer))
      checks.push({
        id: 'workload-sdk',
        label: 'Native runtime',
        status: missing.length ? 'fail' : 'ok',
        detail: missing.length
          ? `Install the ${target} runtime: ${missing.join(', ')}`
          : `${target} runtime SDKs installed`,
      })
      if (framework !== 'nuxt') {
        checks.push({
          id: 'workload-framework',
          label: 'Workload integration',
          status: config.deploy?.automations ? 'fail' : 'warn',
          detail:
            'Automatic durable workload wiring requires Nuxt. Other frameworks must compose the native adapters and entry exports explicitly.',
        })
      }
    }
    if (config.deploy?.automations) {
      const schedules = automationSchedules(config)
      if (Object.keys(schedules).length > 100) {
        throw new Error('Declare at most 100 static automation schedules.')
      }
      for (const schedule of Object.values(schedules)) {
        nextAgentSchedule(schedule.cron, schedule.timeZone)
      }
      checks.push({
        id: 'automations',
        label: 'Automation schedules',
        status: 'ok',
        detail: `${Object.keys(schedules).length} static schedule(s); cloudconfig deploy synchronizes them after publication`,
      })
    } else if (config.connect) {
      checks.push({
        id: 'connect-maintenance',
        label: 'Connect maintenance',
        status: 'warn',
        detail:
          'Add deploy.automations for scheduled token refresh and key rotation, or schedule connect.maintain() yourself.',
      })
    }
    if (target === 'vercel') {
      const models = Object.entries(config.models)
        .filter(
          ([, model]) =>
            model.options.storage &&
            (model.options.storage.maxSize ?? 25 * 1024 * 1024) > 4_000_000,
        )
        .map(([name]) => name)
      if (models.length) {
        checks.push({
          id: 'storage-host-limit',
          label: 'File transport',
          status: 'warn',
          detail: `${models.join(', ')}: Vercel Functions limit request and response bodies to 4.5 MB. Keep proxied files below 4 MB with multipart overhead, or implement direct object-storage uploads and downloads.`,
        })
      }
    }
  } catch (cause) {
    checks.push({
      id: 'workloads',
      label: 'Workload configuration',
      status: 'fail',
      detail: cause instanceof Error ? cause.message : String(cause),
    })
  }
  return checks
}
