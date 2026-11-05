/**
 * Render a project's SQL schema straight from the compiled config.
 *
 * The normal path to a database is the migration flow (`cloudconfig db generate` →
 * `cloudconfig db migrate`), and that is what ships. This module is the escape hatch
 * for a database no migration can reach — an in-memory or throwaway SQLite in a
 * test, say — where the whole schema has to be created in one pass.
 *
 * The DDL is derived from the same drizzle tables the query adapter uses, never
 * a second hand-maintained description of the schema.
 */
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { CompiledBase } from './compile/index.js'

export interface TableDdl {
  table: string
  sql: string
}

/** Quote an identifier for SQLite. */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** Render a JS value as a SQLite literal for a column DEFAULT. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  return `'${JSON.stringify(value).replaceAll("'", "''")}'`
}

/**
 * A drizzle column, narrowed to the metadata this renderer reads. `autoIncrement`
 * lives on the SQLite integer column but is not on the shared base type.
 */
interface ColumnLike {
  name: string
  notNull: boolean
  primary: boolean
  isUnique: boolean
  hasDefault: boolean
  default: unknown
  autoIncrement?: boolean
  getSQLType(): string
  mapToDriverValue(value: unknown): unknown
}

function columnsOf(table: SQLiteTable): ColumnLike[] {
  return getTableConfig(table).columns as unknown as ColumnLike[]
}

/** `"title" text NOT NULL` — the column definition inside CREATE TABLE. */
function columnDdl(col: ColumnLike): string {
  const parts = [quoteIdentifier(col.name), col.getSQLType()]
  if (col.primary) {
    parts.push('PRIMARY KEY')
    if (col.autoIncrement) parts.push('AUTOINCREMENT')
  }
  if (col.notNull) parts.push('NOT NULL')
  if (col.isUnique && !col.primary) parts.push('UNIQUE')
  if (col.hasDefault && col.default !== undefined) {
    parts.push(`DEFAULT ${literal(col.mapToDriverValue(col.default))}`)
  }
  return parts.join(' ')
}

/** Render the `CREATE TABLE IF NOT EXISTS` statement for one compiled model. */
export function createTableSql(table: SQLiteTable): string {
  const config = getTableConfig(table)
  const defs = columnsOf(table).map(columnDdl)

  for (const fk of config.foreignKeys) {
    const ref = fk.reference()
    const local = ref.columns.map((c) => quoteIdentifier(c.name)).join(', ')
    const foreign = ref.foreignColumns.map((c) => quoteIdentifier(c.name)).join(', ')
    const target = getTableConfig(ref.foreignTable).name
    let clause = `FOREIGN KEY (${local}) REFERENCES ${quoteIdentifier(target)}(${foreign})`
    if (fk.onDelete) clause += ` ON DELETE ${fk.onDelete}`
    if (fk.onUpdate) clause += ` ON UPDATE ${fk.onUpdate}`
    defs.push(clause)
  }

  for (const unique of config.uniqueConstraints ?? []) {
    defs.push(`UNIQUE (${unique.columns.map((c) => quoteIdentifier(c.name)).join(', ')})`)
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(config.name)} (\n  ${defs.join(',\n  ')}\n)`
}

/**
 * Every `CREATE TABLE IF NOT EXISTS` for a compiled config, ordered so a table
 * is created after the tables it references, followed by its indexes. (SQLite tolerates a forward
 * reference at CREATE time, but ordering keeps the emitted SQL readable and
 * safe to replay elsewhere.)
 */
export function schemaStatements(base: CompiledBase): TableDdl[] {
  const tables = orderByDependency(Object.values(base.models).map((model) => model.table))
  return [
    ...tables.map((table) => ({ table: getTableConfig(table).name, sql: createTableSql(table) })),
    ...tables.flatMap((table) =>
      createIndexSql(table).map((sql) => ({ table: getTableConfig(table).name, sql })),
    ),
  ]
}

/** `CREATE INDEX IF NOT EXISTS` for each non-unique index a model declares. */
export function createIndexSql(table: SQLiteTable): string[] {
  const config = getTableConfig(table)
  return config.indexes.map(({ config: entry }) => {
    const columns = entry.columns
      .map((column) => quoteIdentifier((column as { name: string }).name))
      .join(', ')
    const kind = entry.unique ? 'UNIQUE INDEX' : 'INDEX'
    return `CREATE ${kind} IF NOT EXISTS ${quoteIdentifier(entry.name)} ON ${quoteIdentifier(config.name)} (${columns})`
  })
}

/** Topological order by foreign-key dependency; cycles fall back to declaration order. */
function orderByDependency(tables: SQLiteTable[]): SQLiteTable[] {
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const ordered: SQLiteTable[] = []

  const visit = (table: SQLiteTable): void => {
    const config = getTableConfig(table)
    if (visited.has(config.name) || visiting.has(config.name)) return
    visiting.add(config.name)
    for (const fk of config.foreignKeys) {
      const target = getTableConfig(fk.reference().foreignTable).name
      if (target === config.name) continue
      const dep = byName.get(target)
      if (dep) visit(dep)
    }
    visiting.delete(config.name)
    visited.add(config.name)
    ordered.push(table)
  }

  for (const table of tables) visit(table)
  return ordered
}
