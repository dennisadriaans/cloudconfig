import { sql } from 'drizzle-orm'
import type { AnyConfig } from '../dsl/model-config.js'
import { configuredDatabase } from '../drivers/configured.js'
import type { DurableRecordStore } from './records.js'

/** Durable workloads share private records; the historical table name preserves existing agent runs. */
export function databaseExecutionRecords(
  config: AnyConfig,
  env?: Record<string, unknown>,
): DurableRecordStore {
  const provider = configuredDatabase(config)
  let ready: Promise<void> | undefined
  async function database() {
    const db = await provider.connect({
      env: env ?? globalThis.process?.env,
      request: new Request('https://cloudconfig.internal'),
    })
    const attempt = (ready ??= Promise.resolve(
      db.run(sql`CREATE TABLE IF NOT EXISTS _cloudconfig_agent_records (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, version TEXT NOT NULL
    )`),
    ).then(() => {}))
    try {
      await attempt
    } catch (cause) {
      if (ready === attempt) ready = undefined
      throw cause
    }
    return db
  }
  return {
    async read(key) {
      return (
        (await (
          await database()
        ).get<{ value: string; version: string }>(
          sql`SELECT value, version FROM _cloudconfig_agent_records WHERE key = ${key}`,
        )) ?? null
      )
    },
    async create(key, value) {
      const rows = await (
        await database()
      ).all(sql`INSERT OR IGNORE INTO _cloudconfig_agent_records
        (key, value, version) VALUES (${key}, ${value}, ${crypto.randomUUID()}) RETURNING key`)
      return rows.length === 1
    },
    async replace(key, value, version) {
      const rows = await (
        await database()
      ).all(sql`UPDATE _cloudconfig_agent_records
        SET value = ${value}, version = ${crypto.randomUUID()}
        WHERE key = ${key} AND version = ${version} RETURNING key`)
      return rows.length === 1
    },
  }
}
