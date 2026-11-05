/**
 * Remote D1 reads for the migration preflight, independent of the CLI that runs them.
 *
 * Wrangler (`d1 execute --remote --json`) and cf (`d1 query`) both return the D1 API's
 * `[{ results }]` array, so one parser serves both.
 */
import type { PreflightDeps } from './migration-preflight.js'

export interface D1ExecuteResult {
  results?: unknown[]
}

/** Run one SQL statement remotely; rejects with the CLI's error output. */
export type D1Execute = (sql: string) => Promise<D1ExecuteResult[]>

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function listRemoteMigrationNames(execute: D1Execute): Promise<string[]> {
  try {
    const result = await execute('SELECT name FROM d1_migrations ORDER BY id;')
    return (result[0]?.results ?? [])
      .map((row) => (row && typeof row === 'object' ? (row as { name?: unknown }).name : undefined))
      .filter((name): name is string => typeof name === 'string')
  } catch (err) {
    // A database that never ran a migration has no ledger table yet.
    if (/no such table:?\s*d1_migrations/i.test(messageOf(err))) return []
    throw err
  }
}

async function readRemoteTableColumns(
  execute: D1Execute,
  table: string,
): Promise<Array<{ name: string; type: string }>> {
  // Validated as a bare identifier, then double-quoted so reserved words parse.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return []
  let result: D1ExecuteResult[]
  try {
    result = await execute(`PRAGMA table_info("${table}");`)
  } catch (err) {
    if (/no such table/i.test(messageOf(err))) return []
    throw err
  }
  const columns: Array<{ name: string; type: string }> = []
  for (const row of result[0]?.results ?? []) {
    if (!row || typeof row !== 'object') continue
    const name = (row as { name?: unknown }).name
    const type = (row as { type?: unknown }).type
    if (typeof name === 'string') columns.push({ name, type: typeof type === 'string' ? type : '' })
  }
  return columns
}

/** Wire the pure preflight engine to a remote D1 reader. */
export function d1PreflightDeps(execute: D1Execute): PreflightDeps {
  return {
    listAppliedMigrations: () => listRemoteMigrationNames(execute),
    readRemoteTableColumns: (table) => readRemoteTableColumns(execute, table),
  }
}
