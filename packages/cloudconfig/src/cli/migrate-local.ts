/**
 * Applies committed `migrations/*.sql` files to a local better-sqlite3 database,
 * tracking applied migrations in a `_cloudconfig_migrations` ledger. Used by
 * `cloudconfig dev` (boot-migrate) and `cloudconfig db migrate` in standalone mode. Framework
 * mode delegates to `wrangler d1 migrations apply` instead.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { requireBetterSqlite3 } from '../shared/better-sqlite3.js'

interface LedgerRow {
  name: string
  hash: string
}

export interface MigrateResult {
  applied: string[]
  alreadyApplied: number
  /** SQL migration files found on disk (may be zero before `cloudconfig db generate`). */
  onDisk: number
}

export interface ApplyLocalMigrationsOptions {
  /** Package-manager-specific install line when better-sqlite3 is missing. */
  installCommand?: string
}

/** Shared copy for migrate / status / boot when no SQL files exist yet. */
export const NO_MIGRATIONS_HINT = 'No migrations generated yet. Run: cloudconfig db generate'

export function listMigrationSqlFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

export interface ListPendingLocalMigrationsOptions {
  /** Package-manager-specific install line when better-sqlite3 is missing. */
  installCommand?: string
}

/**
 * Return on-disk SQL migration filenames not yet recorded in the local
 * `_cloudconfig_migrations` ledger. Used by `cloudconfig db status` and `cloudconfig doctor`.
 * When the database file is missing, every on-disk file is pending.
 */
export function listPendingLocalMigrations(
  dbPath: string,
  files: string[],
  opts?: ListPendingLocalMigrationsOptions,
): string[] {
  if (!existsSync(dbPath)) return [...files]
  const Database = requireBetterSqlite3(opts?.installCommand)
  const db = new Database(dbPath, { readonly: true })
  const applied = new Set<string>()
  try {
    for (const row of db.prepare('SELECT name FROM _cloudconfig_migrations').all()) {
      if (typeof row === 'object' && row !== null && 'name' in row) applied.add(String(row.name))
    }
  } catch {
    // ledger table absent → nothing applied yet
  }
  db.close()
  return files.filter((f) => !applied.has(f))
}

function hash(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16)
}

export function applyLocalMigrations(
  dbPath: string,
  migrationsDir: string,
  opts?: ApplyLocalMigrationsOptions,
): MigrateResult {
  const parent = dirname(dbPath)
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true })

  const files = listMigrationSqlFiles(migrationsDir)

  const Database = requireBetterSqlite3(opts?.installCommand)
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.exec(
    `CREATE TABLE IF NOT EXISTS _cloudconfig_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  )

  const applied = new Map<string, string>()
  for (const row of db.prepare('SELECT name, hash FROM _cloudconfig_migrations').all()) {
    if (isLedgerRow(row)) applied.set(row.name, row.hash)
  }

  const result: MigrateResult = { applied: [], alreadyApplied: applied.size, onDisk: files.length }
  const insert = db.prepare(
    'INSERT INTO _cloudconfig_migrations (name, hash, applied_at) VALUES (?, ?, ?)',
  )

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    const checksum = hash(sql)
    const prev = applied.get(file)
    if (prev) {
      if (prev !== checksum) {
        throw new Error(
          `migration "${file}" was already applied but its contents changed — refusing to reapply. Generate a new migration instead.`,
        )
      }
      continue
    }
    // drizzle-kit separates statements with a "--> statement-breakpoint" marker
    const statements = sql.split('--> statement-breakpoint')
    const tx = db.transaction(() => {
      for (const stmt of statements) {
        const trimmed = stmt.trim()
        if (trimmed) db.exec(trimmed)
      }
      insert.run(file, checksum, new Date().toISOString())
    })
    tx()
    result.applied.push(file)
  }

  db.close()
  return result
}

function isLedgerRow(row: unknown): row is LedgerRow {
  return (
    typeof row === 'object' &&
    row !== null &&
    'name' in row &&
    'hash' in row &&
    typeof row.name === 'string' &&
    typeof row.hash === 'string'
  )
}
