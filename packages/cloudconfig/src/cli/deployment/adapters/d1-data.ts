import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProjectConfig } from '../../../shared/project-config.js'
import { D1_ENV } from '../../../shared/data-env.js'
import { resolveSecretValues } from '../../cloudflare/secrets.js'
import {
  accountIdFrom,
  isPlaceholderDatabaseId,
  readD1Binding,
  readMigrationsDir,
  readWranglerFile,
} from '../../cloudflare/wrangler-config.js'
import { ensureD1, runPreflightAndMigrate } from '../../cloudflare/deploy-data.js'
import { assertSettings } from '../settings.js'
import type { DataDeployment, DeploymentRequest } from '../ports.js'
import { isWranglerInstalled } from '../../wrangler.js'
import { detectPackageManager, installDevDepCommand } from '../../package-manager.js'

export function d1Deployment(request: DeploymentRequest): DataDeployment {
  const { projectDir, config, options, name } = request
  const resolved = resolveProjectConfig(config)
  const file = readWranglerFile(projectDir)
  const binding = file && readD1Binding(file.text)
  if (binding && binding.binding !== resolved.d1Binding) {
    throw new Error(`Wrangler D1 binding must match db.binding (${resolved.d1Binding}).`)
  }
  if (
    file &&
    binding &&
    (readMigrationsDir(file.text) ?? 'migrations') !== resolved.migrationsDir
  ) {
    throw new Error(
      `Wrangler migrations_dir must match db.migrationsDir (${resolved.migrationsDir}).`,
    )
  }
  const { values } = resolveSecretValues(
    [...Object.values(D1_ENV), 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
    projectDir,
  )
  const env: Record<string, string> = {}
  const account =
    values[D1_ENV.accountId] ??
    values['CLOUDFLARE_ACCOUNT_ID'] ??
    (file && accountIdFrom(file.text))
  const token = values[D1_ENV.apiToken] ?? values['CLOUDFLARE_API_TOKEN']
  const databaseId = binding?.databaseId
  if (account) env[D1_ENV.accountId] = account
  if (token) env[D1_ENV.apiToken] = token
  if (databaseId && !isPlaceholderDatabaseId(databaseId)) env[D1_ENV.databaseId] = databaseId
  assertSettings([D1_ENV.accountId, D1_ENV.apiToken], env)
  if (!options.dryRun && !isWranglerInstalled(projectDir)) {
    throw new Error(
      `D1 migrations require Wrangler even when the app runs on ${request.target}. Install it once: ${installDevDepCommand(detectPackageManager(projectDir), 'wrangler')}`,
    )
  }
  return {
    env,
    async migrate() {
      // No Wrangler main is needed for data-only provisioning. Never replace an existing config.
      let current = readWranglerFile(projectDir)
      if (!current) {
        const path = join(projectDir, 'wrangler.jsonc')
        const text = JSON.stringify({ name, account_id: account }, null, 2) + '\n'
        writeFileSync(path, text)
        current = { path, text, format: 'json' }
      }
      const ensured = await ensureD1(projectDir, current, {
        dbName: config.deploy?.d1 ?? resolved.dbName ?? `${name}-db`,
        binding: resolved.d1Binding,
        migrationsDir: resolved.migrationsDir,
        dryRun: false,
      })
      if (!ensured) throw new Error('D1 provisioning failed; no app was published.')
      const provisioned = readD1Binding(ensured.file.text)
      if (!provisioned) throw new Error('D1 provisioning did not produce a database binding.')
      env[D1_ENV.databaseId] = provisioned.databaseId
      const outcome = await runPreflightAndMigrate(projectDir, {
        dbName: ensured.databaseName,
        migrationsDir: join(projectDir, resolved.migrationsDir),
        force: options.force === true,
        dryRun: false,
      })
      if (!outcome.ok) {
        throw new Error('D1 migration preflight or apply failed; no app was published.')
      }
    },
  }
}
