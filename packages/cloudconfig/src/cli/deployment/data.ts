import { join } from 'node:path'
import { resolveProjectConfig } from '../../shared/project-config.js'
import { D1_ENV, storageEnvNames, validateDataServices } from '../../shared/data-env.js'
import { resolveDatabaseProvider } from '../../shared/database-provider.js'
import { resolveSecretValues } from '../cloudflare/secrets.js'
import { accountIdFrom, readR2Binding, readWranglerFile } from '../cloudflare/wrangler-config.js'
import { listLocalMigrationFiles, loadLatestSnapshot } from './migrations/preflight.js'
import { assertSettings } from './settings.js'
import { d1Deployment } from './adapters/d1-data.js'
import { libsqlDeployment } from './adapters/libsql-data.js'
import type { DataDeployment, DeploymentRequest } from './ports.js'

/** Hosting and data adapters compose independently once a database provider is selected. */
export function prepareDataDeployment(request: DeploymentRequest): DataDeployment {
  const { config, projectDir } = request
  const data = prepareDatabaseDeployment(request)
  const hasStorage = Object.values(config.models).some((model) => model.options.storage)
  if (config.storage || (request.target !== 'cloudflare' && (hasStorage || config.deploy?.r2))) {
    const names = storageEnvNames(config)
    const { values } = resolveSecretValues(Object.values(names), projectDir)
    if (!config.storage) {
      const file = readWranglerFile(projectDir)
      const { values: accountSettings } = resolveSecretValues(
        [D1_ENV.accountId, 'CLOUDFLARE_ACCOUNT_ID'],
        projectDir,
      )
      const accountId =
        accountSettings[D1_ENV.accountId] ??
        accountSettings['CLOUDFLARE_ACCOUNT_ID'] ??
        (file && accountIdFrom(file.text))
      const bucket = config.deploy?.r2 ?? (file && readR2Binding(file.text)?.bucketName)
      if (accountId) values[names.endpoint] ??= `https://${accountId}.r2.cloudflarestorage.com`
      if (bucket) values[names.bucket] ??= bucket
    }
    assertSettings(Object.values(names), values)
    Object.assign(data.env, values)
  }
  return data
}

export function prepareDatabaseDeployment(request: DeploymentRequest): DataDeployment {
  const { config, projectDir } = request
  const migrationsDir = join(projectDir, resolveProjectConfig(config).migrationsDir)
  validateDataServices(config)
  if (!listLocalMigrationFiles(migrationsDir).length || !loadLatestSnapshot(migrationsDir)) {
    throw new Error(
      'Generate SQL migrations and snapshots before deploying: cloudconfig db generate. External schemas must use their own schema tooling.',
    )
  }
  return resolveDatabaseProvider(config) === 'd1'
    ? d1Deployment(request)
    : libsqlDeployment(request, migrationsDir)
}
