/** D1 over HTTPS for an app hosted outside Workers. Keeps the existing database and SQL schema. */
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { Db, DbProvider } from '../server/driver.js'
import { D1_ENV } from '../shared/data-env.js'
import { readEnv } from '../server/auth/env.js'

interface QueryResult {
  success: boolean
  results?: { columns: string[]; rows: unknown[][] }
}

export function d1Http(): DbProvider {
  let connection: { accountId: string; databaseId: string; apiToken: string; db: Db } | undefined
  return {
    id: 'd1-http',
    connect({ env }) {
      const accountId = readEnv(D1_ENV.accountId, env)
      const databaseId = readEnv(D1_ENV.databaseId, env)
      const apiToken = readEnv(D1_ENV.apiToken, env)
      if (!accountId || !databaseId || !apiToken) {
        throw new Error(`Remote D1 requires ${Object.values(D1_ENV).join(', ')}.`)
      }
      if (
        connection?.accountId === accountId &&
        connection.databaseId === databaseId &&
        connection.apiToken === apiToken
      ) {
        return connection.db
      }
      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/raw`
      const db = drizzle(async (sql, params, method) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql, params }),
          signal: AbortSignal.timeout(30_000),
        })
        const payload = (await response.json()) as {
          success: boolean
          result?: QueryResult[]
          errors?: { message: string }[]
        }
        const query = payload.result?.[0]
        if (!response.ok || !payload.success || !query?.success) {
          throw new Error(
            `Remote D1 query failed (${response.status}): ${payload.errors?.map(({ message }) => message).join('; ') || 'unsuccessful query'}`,
          )
        }
        const rows = query.results?.rows ?? []
        return { rows: method === 'get' ? (rows[0] ?? []) : rows }
      })
      connection = { accountId, databaseId, apiToken, db }
      return db
    },
  }
}
