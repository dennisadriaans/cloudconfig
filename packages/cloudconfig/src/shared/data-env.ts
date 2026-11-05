import type { AnyConfig } from '../dsl/model-config.js'
import { resolveDatabaseProvider } from './database-provider.js'

export function validateDataServices(config: AnyConfig): void {
  resolveDatabaseProvider(config)
  if (config.storage && config.storage.provider !== 's3') {
    throw new Error(
      'Unsupported storage.provider. Expected s3, or supply an ObjectStoreProvider to your backend.',
    )
  }
}

export const D1_ENV = {
  accountId: 'CLOUDCONFIG_D1_ACCOUNT_ID',
  databaseId: 'CLOUDCONFIG_D1_DATABASE_ID',
  apiToken: 'CLOUDCONFIG_D1_API_TOKEN',
} as const

export function databaseEnvNames(config: AnyConfig): { url: string; token: string } {
  const provider = resolveDatabaseProvider(config)
  const remote = config.db?.remote
  const overrides = remote?.provider === 'd1' ? undefined : remote
  return {
    url:
      overrides?.urlEnv ??
      (provider === 'turso' ? 'TURSO_DATABASE_URL' : 'CLOUDCONFIG_DATABASE_URL'),
    token:
      overrides?.tokenEnv ??
      (provider === 'turso' ? 'TURSO_AUTH_TOKEN' : 'CLOUDCONFIG_DATABASE_TOKEN'),
  }
}

/** A production connection must never open a temporary local database. */
export function validateRemoteDatabaseUrl(url: string): void {
  if (!['libsql:', 'https:'].includes(new URL(url).protocol)) {
    throw new Error(
      'Production libSQL requires a libsql:// or https:// URL; local files are not persistent app-host storage.',
    )
  }
}

export function storageEnvNames(config: AnyConfig) {
  return {
    endpoint: config.storage?.endpointEnv ?? 'CLOUDCONFIG_STORAGE_ENDPOINT',
    bucket: config.storage?.bucketEnv ?? 'CLOUDCONFIG_STORAGE_BUCKET',
    accessKeyId: config.storage?.accessKeyIdEnv ?? 'CLOUDCONFIG_STORAGE_ACCESS_KEY_ID',
    secretAccessKey: config.storage?.secretAccessKeyEnv ?? 'CLOUDCONFIG_STORAGE_SECRET_ACCESS_KEY',
  }
}
