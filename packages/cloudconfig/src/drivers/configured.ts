/** Composition root for built-in database adapters. Native SQLite is only loaded in development. */
import type { AnyConfig } from '../dsl/model-config.js'
import type { DbProvider } from '../server/driver.js'
import { readEnv } from '../server/auth/env.js'
import { databaseEnvNames, D1_ENV, validateDataServices } from '../shared/data-env.js'
import { resolveDatabaseProvider } from '../shared/database-provider.js'

export function configuredDatabase(config: AnyConfig): DbProvider {
  validateDataServices(config)
  const provider = resolveDatabaseProvider(config)
  let local: Promise<DbProvider> | undefined
  let remoteLibsql: DbProvider | undefined
  let remoteD1: DbProvider | undefined
  return {
    id: 'configured',
    async connect(ctx) {
      const isProduction = readEnv('NODE_ENV', ctx.env) === 'production'
      const binding = config.db?.binding ?? 'DB'
      if (isProduction && provider !== 'd1') {
        const { libsql } = await import('./libsql.js')
        remoteLibsql ??= libsql(databaseEnvNames(config))
        return remoteLibsql.connect(ctx)
      }
      if (provider === 'd1' && ctx.env?.[binding]) {
        const { d1 } = await import('./d1.js')
        return d1(binding).connect(ctx)
      }
      if (provider === 'd1' && (isProduction || readEnv(D1_ENV.databaseId, ctx.env))) {
        const { d1Http } = await import('./d1-http.js')
        remoteD1 ??= d1Http()
        return remoteD1.connect(ctx)
      }
      local ??= (async () => {
        const [{ sqliteFile }, { mkdirSync }, { dirname }] = await Promise.all([
          import('./better-sqlite3.js'),
          import('node:fs'),
          import('node:path'),
        ])
        const path = config.db?.local ?? '.cloudconfig/dev.db'
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
        return sqliteFile(path)
      })()
      return (await local).connect(ctx)
    },
  }
}
