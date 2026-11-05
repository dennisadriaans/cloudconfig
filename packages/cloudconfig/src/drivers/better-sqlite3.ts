/**
 * `cloudconfig/drivers/better-sqlite3` — a local-file (or in-memory) SQLite driver.
 * Loads the native `better-sqlite3` module lazily so importing this subpath does
 * not crash when the optional peer is not installed yet; `connect()` then throws
 * an actionable install hint.
 */
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { requireBetterSqlite3 } from '../shared/better-sqlite3.js'
import type { Db, DbProvider } from '../server/driver.js'

/**
 * Build a driver backed by a better-sqlite3 database. Pass `':memory:'` for an
 * ephemeral database (tests), or a file path for local dev.
 */
export function sqliteFile(path = '.cloudconfig/dev.db'): DbProvider {
  let db: Db | undefined
  return {
    id: 'better-sqlite3',
    connect(): Db {
      if (!db) {
        const Database = requireBetterSqlite3()
        const sqlite = new Database(path)
        sqlite.pragma('foreign_keys = ON')
        db = drizzle(sqlite)
      }
      return db
    },
  }
}
