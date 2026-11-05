import { resolveProjectConfig, type AnyConfig } from './index.js'
import { resolveDatabaseProvider } from './shared/database-provider.js'
import { deploySecretNames } from './shared/deploy-secrets.js'

/** A D1 binding in `cloudflare.config.ts`, as `bindings.d1()` returns it. */
export interface CloudflareD1Binding {
  type: 'd1'
  name: string
  id?: string
}

/** An R2 binding in `cloudflare.config.ts`, as `bindings.r2()` returns it. */
export interface CloudflareR2Binding {
  type: 'r2'
  name: string
}

/** A secret declaration in `cloudflare.config.ts`, as `bindings.secret()` returns it. */
export interface CloudflareSecretBinding {
  type: 'secret'
}

export type CloudflareBinding = CloudflareD1Binding | CloudflareR2Binding | CloudflareSecretBinding

export interface CloudflareBindingsOptions {
  /**
   * D1 database name, when the config sets neither `db.name` nor `deploy.d1`.
   *
   * cf and `cloudconfig deploy` find or create the database by this name.
   */
  databaseName?: string
  /** Pin the D1 database by id instead of resolving its name. */
  databaseId?: string
}

/**
 * Cloudflare bindings for cf's `cloudflare.config.ts`, derived from `cloud.config.ts`.
 *
 * Spread the result into `worker.env` so one config declares the D1 database, the
 * `deploy.r2` bucket and every secret `cloudconfig deploy` uploads; cf only uploads
 * secrets the Worker declares. Add the application's own bindings next to it.
 * @throws When the config stores data in D1 but names no database.
 * @example
 * import { bindings, defineConfig } from 'cf/config'
 * import { cloudflareBindings } from '@cloudconfig/core/cloudflare'
 * import config from './cloud.config.ts'
 *
 * export default defineConfig({
 *   worker: {
 *     name: 'notes',
 *     compatibilityDate: '2026-10-14',
 *     entrypoint: './src/index.ts',
 *     env: { ...cloudflareBindings(config), ASSETS: bindings.assets() },
 *   },
 * })
 */
export function cloudflareBindings(
  config: AnyConfig,
  { databaseName, databaseId }: CloudflareBindingsOptions = {},
): Record<string, CloudflareBinding> {
  const env: Record<string, CloudflareBinding> = {}
  const { required, optional } = deploySecretNames(config)
  for (const name of [...required, ...optional]) env[name] = { type: 'secret' }

  if (resolveDatabaseProvider(config) === 'd1') {
    const { d1Binding, dbName } = resolveProjectConfig(config)
    const name = config.deploy?.d1 ?? dbName ?? databaseName
    if (!name) {
      throw new Error(
        'Name the D1 database: set db.name in cloud.config.ts, or pass { databaseName } to cloudflareBindings.',
      )
    }
    env[d1Binding] = { type: 'd1', name, ...(databaseId ? { id: databaseId } : {}) }
  }

  const { r2, r2Binding = 'BUCKET' } = config.deploy ?? {}
  if (r2) env[r2Binding] = { type: 'r2', name: r2 }
  return env
}
