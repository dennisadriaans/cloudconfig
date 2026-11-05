/**
 * The connection-level database seam. A `DbProvider` turns the per-request
 * platform env into a drizzle database handle bound to the compiled tables.
 * Keeping this an interface lets the D1 / better-sqlite3 / libsql drivers live
 * behind their own subpath exports so native deps never enter a Workers bundle.
 *
 * Note the layering: `DbProvider` is deliberately drizzle-shaped — it is how
 * SQLite *connections* plug into the built-in drizzle adapter. The ORM-free
 * seam one level up is `DataProvider`/`DataAdapter` in `ports.ts`; implement
 * that instead to swap the engine or the ORM entirely.
 */
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { ConnectContext } from './ports.js'

/** A drizzle SQLite database handle — sync or async driver, any result mode. */
export type Db = BaseSQLiteDatabase<'sync' | 'async', unknown, Record<string, never>>

export interface DbProvider {
  /** Human name for diagnostics, e.g. "d1", "better-sqlite3". */
  readonly id: string
  connect(ctx: ConnectContext): Db | Promise<Db>
}

export type { ConnectContext }
