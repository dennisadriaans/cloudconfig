/**
 * Read-only safety gate that runs before any remote SQLite mutation.
 *
 * Answers three questions without writing anything: which local migrations are
 * PENDING, whether applied migrations were TAMPERED with (edited, renamed or
 * deleted locally after being applied), and whether the live remote schema
 * DRIFTS from the schema its *last applied* migration should have produced.
 *
 * The baseline is the point of the check: comparing a pre-migration database
 * against the target snapshot reports every column the pending migrations are
 * about to add as "missing", which blocks the ordinary add-a-column deploy. The
 * target snapshot is verified separately, after the migrations run.
 *
 * Drift is the failure class that breaks production silently: a column applied
 * as `integer` while the schema says `real` passes every create check and then
 * makes the runtime insert fail. Policy (block, warn, bypass) lives in the
 * caller; this module only reports.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface SnapshotColumn {
  name: string
  /** Drizzle snapshot SQL type, lowercase: `integer` | `text` | `real` | … */
  type: string
  notNull: boolean
  primaryKey: boolean
}

export interface SnapshotTable {
  name: string
  columns: Map<string, SnapshotColumn>
}

export type DriftKind = 'missing-column' | 'unexpected-column' | 'type-mismatch'

export interface DriftIssue {
  table: string
  column: string
  kind: DriftKind
  expected?: string
  actual?: string
}

export interface TamperIssue {
  kind: 'missing-local'
  /** Migration name as recorded in the remote ledger. */
  name: string
  detail: string
}

export interface MigrationPlan {
  /** Local migrations not yet in the remote ledger, in apply order. */
  pending: string[]
  tamper: TamperIssue[]
  /** Live-vs-baseline differences. Empty when the drift check was skipped. */
  drift: DriftIssue[]
  driftChecked: boolean
  /** Snapshot the live schema was compared against (`0003_snapshot.json`). */
  driftBaseline?: string
}

/** Injected so the engine stays testable without spawning wrangler. */
export interface PreflightDeps {
  /** Migration names in the remote adapter's ledger, in apply order. */
  listAppliedMigrations: () => Promise<string[]>
  /** `PRAGMA table_info` for one table; empty when the table is absent. */
  readRemoteTableColumns: (table: string) => Promise<Array<{ name: string; type: string }>>
}

interface RawSnapshot {
  tables?: Record<string, { columns?: Record<string, Record<string, unknown>> }>
}

/** Numeric prefix of a Drizzle migration/snapshot file (`0004_x.sql` → 4). */
function migrationIndex(file: string): number | null {
  const match = /^(\d{4})_/.exec(file)
  if (!match) return null
  const index = Number.parseInt(match[1] ?? '', 10)
  return Number.isInteger(index) ? index : null
}

/** All `*.sql` migrations in apply order (numeric prefix, then name). */
export function listLocalMigrationFiles(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) return []
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => {
      const ia = migrationIndex(a)
      const ib = migrationIndex(b)
      if (ia !== null && ib !== null && ia !== ib) return ia - ib
      return a.localeCompare(b)
    })
}

/** Snapshot file names (`NNNN_snapshot.json`) in migration order. */
function snapshotFiles(migrationsDir: string): string[] {
  const metaDir = join(migrationsDir, 'meta')
  if (!existsSync(metaDir)) return []
  return readdirSync(metaDir)
    .filter((file) => /^\d{4}_snapshot\.json$/.test(file))
    .sort((a, b) => (migrationIndex(a) ?? 0) - (migrationIndex(b) ?? 0))
}

export interface LoadedSnapshot {
  file: string
  tables: Map<string, SnapshotTable>
}

/**
 * The snapshot for a migration index — the schema shape Drizzle expects once
 * that migration has been applied. Drizzle writes one `meta/NNNN_snapshot.json`
 * per migration, so the index of the last applied migration names the baseline.
 */
export function loadSnapshotAt(migrationsDir: string, index: number): LoadedSnapshot | null {
  const file = snapshotFiles(migrationsDir).find((name) => migrationIndex(name) === index)
  return file ? parseSnapshot(migrationsDir, file) : null
}

/** The newest snapshot — the schema the app expects *after* every migration. */
export function loadLatestSnapshot(migrationsDir: string): LoadedSnapshot | null {
  const latest = snapshotFiles(migrationsDir).at(-1)
  return latest ? parseSnapshot(migrationsDir, latest) : null
}

function parseSnapshot(migrationsDir: string, file: string): LoadedSnapshot | null {
  let raw: RawSnapshot
  try {
    raw = JSON.parse(readFileSync(join(migrationsDir, 'meta', file), 'utf8')) as RawSnapshot
  } catch {
    throw new Error(
      `Cannot read migration snapshot meta/${file}. Restore it from version control before deploying.`,
    )
  }

  if (!raw || typeof raw.tables !== 'object' || raw.tables === null) {
    throw new Error(`Invalid migration snapshot meta/${file}: missing tables.`)
  }

  const tables = new Map<string, SnapshotTable>()
  for (const [tableName, table] of Object.entries(raw.tables ?? {})) {
    const columns = new Map<string, SnapshotColumn>()
    for (const [colName, col] of Object.entries(table.columns ?? {})) {
      columns.set(colName, {
        name: colName,
        type: typeof col['type'] === 'string' ? col['type'] : 'unknown',
        notNull: col['notNull'] === true,
        primaryKey: col['primaryKey'] === true,
      })
    }
    tables.set(tableName, { name: tableName, columns })
  }
  return { file, tables }
}

/**
 * Collapse a type name to its SQLite storage affinity, so snapshot `real` and
 * PRAGMA `REAL` compare equal while `integer` vs `real` still differs.
 */
export function typeAffinity(rawType: string): string {
  const t = rawType.toUpperCase()
  if (t.includes('INT')) return 'INTEGER'
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT'
  if (t.includes('BLOB') || t.trim() === '') return 'BLOB'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

async function detectDrift(
  snapshot: Map<string, SnapshotTable>,
  deps: PreflightDeps,
): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = []

  for (const [tableName, table] of snapshot) {
    const remoteColumns = await deps.readRemoteTableColumns(tableName)
    const remoteByName = new Map(remoteColumns.map((c) => [c.name, typeAffinity(c.type)]))

    for (const [colName, col] of table.columns) {
      const remoteAffinity = remoteByName.get(colName)
      if (remoteAffinity === undefined) {
        issues.push({ table: tableName, column: colName, kind: 'missing-column' })
        continue
      }
      if (remoteAffinity !== typeAffinity(col.type)) {
        issues.push({
          table: tableName,
          column: colName,
          kind: 'type-mismatch',
          expected: col.type,
          actual: remoteAffinity.toLowerCase(),
        })
      }
    }

    for (const remote of remoteColumns) {
      if (!table.columns.has(remote.name)) {
        issues.push({ table: tableName, column: remote.name, kind: 'unexpected-column' })
      }
    }
  }

  return issues
}

/**
 * Applied migrations with no local counterpart: renamed or deleted after being
 * applied, which leaves the ledger pointing at a file the repo no longer has.
 */
function detectTamper(
  localFiles: readonly string[],
  appliedNames: readonly string[],
): TamperIssue[] {
  const localSet = new Set(localFiles)
  return appliedNames
    .filter((name) => !localSet.has(name))
    .map((name) => ({
      kind: 'missing-local' as const,
      name,
      detail: 'applied remotely but no longer present in the local migrations folder',
    }))
}

/** Highest migration index in the remote ledger, or null for a fresh database. */
function lastAppliedIndex(applied: readonly string[]): number | null {
  let highest: number | null = null
  for (const name of applied) {
    const index = migrationIndex(name)
    if (index !== null && (highest === null || index > highest)) highest = index
  }
  return highest
}

/**
 * Build the full plan.
 *
 * Drift is measured against the snapshot of the last *applied* migration, which
 * is the only schema the remote database is supposed to have right now. A fresh
 * database (empty ledger) has no baseline and nothing to drift from.
 */
export async function buildMigrationPlan(
  migrationsDir: string,
  deps: PreflightDeps,
): Promise<MigrationPlan> {
  const localFiles = listLocalMigrationFiles(migrationsDir)
  const applied = await deps.listAppliedMigrations()
  const appliedSet = new Set(applied)

  const pending = localFiles.filter((file) => !appliedSet.has(file))
  const tamper = detectTamper(localFiles, applied)

  const baselineIndex = lastAppliedIndex(applied)
  const snapshot = baselineIndex === null ? null : loadSnapshotAt(migrationsDir, baselineIndex)
  if (applied.length > 0 && !snapshot) {
    throw new Error(
      'Cannot verify the applied database schema: its migration snapshot is missing. Restore the applied migrations and snapshots from version control.',
    )
  }
  const drift = snapshot ? await detectDrift(snapshot.tables, deps) : []

  return {
    pending,
    tamper,
    drift,
    driftChecked: snapshot !== null,
    ...(snapshot ? { driftBaseline: snapshot.file } : {}),
  }
}

/**
 * Post-migration check: does the live schema now match the target snapshot?
 *
 * Run after the pending migrations are applied and before the app is deployed —
 * a migration that only half-applied leaves code running against a schema it
 * does not expect, which is the same failure class as drift.
 */
export async function verifyTargetSchema(
  migrationsDir: string,
  deps: PreflightDeps,
): Promise<{ drift: DriftIssue[]; checked: boolean; snapshot?: string }> {
  const snapshot = loadLatestSnapshot(migrationsDir)
  if (!snapshot) return { drift: [], checked: false }
  return { drift: await detectDrift(snapshot.tables, deps), checked: true, snapshot: snapshot.file }
}

/** Drift that actually breaks the runtime: a wrong type or a missing column. */
export function hasBlockingDrift(plan: MigrationPlan): boolean {
  return plan.drift.some((change) => change.kind !== 'unexpected-column')
}

// A renamed applied migration must not be replayed under its new filename.
export function planBlocks(plan: MigrationPlan): boolean {
  return hasBlockingDrift(plan) || plan.tamper.length > 0
}

/** Safe to apply, but the user should still be told something. */
export function planWarns(plan: MigrationPlan): boolean {
  if (planBlocks(plan)) return false
  return plan.tamper.length > 0 || plan.drift.length > 0
}

export function planIsClean(plan: MigrationPlan): boolean {
  return plan.tamper.length === 0 && plan.drift.length === 0
}
