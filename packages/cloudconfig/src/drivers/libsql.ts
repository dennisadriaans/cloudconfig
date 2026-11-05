import { createClient } from '@libsql/client/web'
import { drizzle } from 'drizzle-orm/libsql/web'
import type { Db, DbProvider } from '../server/driver.js'
import { readEnv } from '../server/auth/env.js'
import { validateRemoteDatabaseUrl } from '../shared/data-env.js'

/** Shared connection driver for Turso and other hosted libSQL services. */
export function libsql(names: { url: string; token: string }): DbProvider {
  let connection: { url: string; authToken: string; db: Db } | undefined
  return {
    id: 'libsql',
    connect({ env }) {
      const url = readEnv(names.url, env)
      const authToken = readEnv(names.token, env)
      if (!url || !authToken) throw new Error(`Database requires ${names.url} and ${names.token}.`)
      validateRemoteDatabaseUrl(url)
      if (connection?.url !== url || connection.authToken !== authToken) {
        connection = { url, authToken, db: drizzle(createClient({ url, authToken })) }
      }
      return connection.db
    },
  }
}
