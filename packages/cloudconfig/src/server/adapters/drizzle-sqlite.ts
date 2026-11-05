/**
 * The built-in `DataAdapter`: drizzle-on-SQLite. This is the ONLY module that
 * turns portable core types (FilterNode predicates, ListQuery) into drizzle
 * queries — swap the database engine or the ORM by implementing `DataAdapter`
 * elsewhere; nothing above this file changes.
 *
 * Produces the same wire shapes DashboardStack does — `PagedResult` for lists
 * and nested belongs-to objects for relations.
 */
import {
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  getTableColumns,
  like,
  isNotNull,
  isNull,
  max,
  min,
  or,
  sql,
  sum,
  type Column,
  type SQL,
} from 'drizzle-orm'
import { alias, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { FilterNode } from '../../index.js'
import type { CompiledBase, CompiledModel } from '../compile/index.js'
import type { Db, DbProvider } from '../driver.js'
import { buildFilterSQL } from '../filters-sql.js'
import {
  RELATION_PROJECTION_KEYS,
  type AdapterAggregateQuery,
  type AggregateBucket,
  type AggregateInterval,
  type AggregateResult,
  type DataAdapter,
  type DataProvider,
  type PagedResult,
} from '../ports.js'

function tableColumns(table: SQLiteTable): Record<string, SQLiteColumn> {
  return getTableColumns(table)
}

/** The generic-Column view needed by the filter compiler. */
function columnMap(table: SQLiteTable): Record<string, Column> {
  return getTableColumns(table)
}

/** String, non-PK columns — the search targets. */
function searchableColumns(table: SQLiteTable, fields?: readonly string[]): SQLiteColumn[] {
  const cols = tableColumns(table)
  const out: SQLiteColumn[] = []
  for (const [key, col] of Object.entries(cols)) {
    if (key === 'id') continue
    if (fields && !fields.includes(key)) continue
    if (col.columnType.includes('Text') || col.dataType === 'string') out.push(col)
  }
  return out
}

function searchSQL(table: SQLiteTable, term: string, fields?: readonly string[]): SQL | undefined {
  const cols = searchableColumns(table, fields)
  if (cols.length === 0) return undefined
  const parts = cols.map((c) => like(c, `%${term}%`))
  return parts.length === 1 ? parts[0] : or(...parts)
}

function combineWhere(...parts: Array<SQL | undefined>): SQL | undefined {
  const present = parts.filter((part): part is SQL => Boolean(part))
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return and(...present)
}

/**
 * Build the SELECT projection and joins for a model. Non-relation columns are
 * selected directly; each belongs-to relation becomes a left join with the
 * target's label columns nested under the relation key, and the raw FK column
 * is omitted from the top level (matching DashboardStack's select shape).
 */
function buildSelection(
  base: CompiledBase,
  model: CompiledModel,
): {
  select: Record<string, SQLiteColumn | SQL>
  joins: Array<{ table: SQLiteTable; on: SQL }>
  relationKeys: Set<string>
} {
  const cols = tableColumns(model.table)
  const select: Record<string, SQLiteColumn | SQL> = {}
  const joins: Array<{ table: SQLiteTable; on: SQL }> = []
  const relationKeys = new Set<string>()
  const fkColumns = new Set(model.relationships.map((relation) => relation.fieldName))

  for (const [key, col] of Object.entries(cols)) {
    if (fkColumns.has(key)) continue
    select[key] = col
  }

  for (const rel of model.relationships) {
    const target = base.models[rel.targetModel]
    if (!target) continue
    const joined = alias(target.table, rel.relationKey)
    const joinedCols = getTableColumns(joined)
    const fkCol = cols[rel.fieldName]
    const targetId = joinedCols['id']
    if (!fkCol || !targetId) continue
    joins.push({ table: joined, on: eq(fkCol, targetId) })
    relationKeys.add(rel.relationKey)

    for (const [jkey, jcol] of Object.entries(joinedCols)) {
      if (!RELATION_PROJECTION_KEYS.has(jkey)) continue
      select[`${rel.relationKey}__${jkey}`] = jcol
    }
    // the raw FK column is intentionally omitted from the projection; a null
    // target surfaces as a null nested object (see nestRow), matching the
    // DashboardStack select shape.
  }

  return { select, joins, relationKeys }
}

// Weeks start on Monday: forward to that week's Sunday, then back six days.
const PERIOD_FORMATS: Record<AggregateInterval, string> = {
  day: `'%Y-%m-%d', {column}`,
  week: `'%Y-%m-%d', {column}, 'weekday 0', '-6 days'`,
  month: `'%Y-%m', {column}`,
}

function periodSQL(column: SQLiteColumn, interval: AggregateInterval): SQL<string | null> {
  const [before = '', after = ''] = PERIOD_FORMATS[interval].split('{column}')
  return sql<string | null>`strftime(${sql.raw(before)}${column}${sql.raw(after)})`
}

function reducerSQL(
  op: AdapterAggregateQuery['op'],
  column: SQLiteColumn | undefined,
): SQL<unknown> {
  if (op === 'count') return column ? count(column) : count()
  if (!column) throw new Error(`drizzle-sqlite adapter: ${op} needs a column`)
  if (op === 'sum') return sql`coalesce(${sum(column)}, 0)`
  if (op === 'avg') return avg(column)
  return op === 'min' ? min(column) : max(column)
}

function bucketKey(value: unknown): AggregateBucket['key'] {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null
}

function toNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/** The target's first public label column, for naming relation groups. */
function relationLabelColumn(target: CompiledModel, table: SQLiteTable): SQLiteColumn | undefined {
  const columns = tableColumns(table)
  const key = ['name', 'title', 'label', 'email', 'slug'].find(
    (candidate) => columns[candidate] && !target.fieldSpecs[candidate]?.spec.serverOnly,
  )
  return key ? columns[key] : undefined
}

/** Fold flat `rel__key` columns back into nested objects. */
function nestRow(row: Record<string, unknown>, relationKeys: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const nested: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(row)) {
    const sep = key.indexOf('__')
    if (sep === -1) {
      out[key] = value
      continue
    }
    const relKey = key.slice(0, sep)
    const field = key.slice(sep + 2)
    ;(nested[relKey] ??= {})[field] = value
  }
  for (const relKey of relationKeys) {
    const obj = nested[relKey]
    out[relKey] = obj && obj['id'] != null ? obj : null
  }
  return out
}

/** A `DataAdapter` over a connected drizzle SQLite database. */
export function drizzleSqliteAdapter(
  base: CompiledBase,
  db: Db,
  listFields?: readonly string[],
): DataAdapter {
  function modelOf(name: string): CompiledModel {
    const model = base.models[name]
    if (!model) throw new Error(`drizzle-sqlite adapter: unknown model "${name}"`)
    return model
  }

  function accessWhere(model: CompiledModel, filter: FilterNode | undefined): SQL | undefined {
    return filter ? buildFilterSQL(filter, columnMap(model.table)) : undefined
  }

  async function find(
    model: CompiledModel,
    id: number,
    accessFilter?: FilterNode,
  ): Promise<Record<string, unknown> | undefined> {
    const { select, joins, relationKeys } = buildSelection(base, model)
    const idCol = tableColumns(model.table)['id']
    if (!idCol) return undefined
    const where = combineWhere(eq(idCol, id), accessWhere(model, accessFilter))

    let statement = db.select(select).from(model.table).$dynamic()
    for (const join of joins) statement = statement.leftJoin(join.table, join.on)
    if (where) statement = statement.where(where)
    const rows = await statement.limit(1)
    const row = rows[0]
    return row ? nestRow(row, relationKeys) : undefined
  }

  async function exists(
    model: CompiledModel,
    id: number,
    accessFilter?: FilterNode,
  ): Promise<boolean> {
    const idCol = tableColumns(model.table)['id']
    if (!idCol) return false
    const where = combineWhere(eq(idCol, id), accessWhere(model, accessFilter))
    const rows = await db.select({ id: idCol }).from(model.table).where(where).limit(1)
    return rows.length > 0
  }

  async function aggregateBuckets(
    model: CompiledModel,
    query: AdapterAggregateQuery,
    groupBy: string,
    reducer: SQL<unknown>,
    where: SQL | undefined,
  ): Promise<AggregateBucket[]> {
    const column = tableColumns(model.table)[groupBy]
    if (!column) return []
    const { interval, limit } = query
    const relation = model.relationships.find(({ fieldName }) => fieldName === groupBy)
    const target = relation ? base.models[relation.targetModel] : undefined
    const joined = target ? alias(target.table, 'group_target') : undefined
    const label = target && joined ? relationLabelColumn(target, joined) : undefined
    const targetId = joined ? tableColumns(joined)['id'] : undefined
    const key = interval ? periodSQL(column, interval) : column

    let statement = db
      .select({ key, value: reducer.as('value'), ...(label ? { label } : {}) })
      .from(model.table)
      .$dynamic()
    if (joined && label && targetId) statement = statement.leftJoin(joined, eq(column, targetId))

    const rows = await statement
      .where(combineWhere(where, interval ? isNotNull(column) : undefined))
      .groupBy(key, ...(label ? [label] : []))
      .orderBy(...(interval ? [desc(key)] : [desc(sql`value`), asc(key)]))
      .limit(limit)
    const buckets = rows.map((row): AggregateBucket => {
      const name = row['label']
      return {
        key: bucketKey(row.key),
        value: toNumber(row.value),
        ...(typeof name === 'string' ? { label: name } : {}),
      }
    })

    return interval ? buckets.reverse() : buckets
  }

  return {
    async aggregate(name, query): Promise<AggregateResult> {
      const model = modelOf(name)
      const { op, field, groupBy, filters, accessFilter } = query
      const reducer = reducerSQL(op, field ? tableColumns(model.table)[field] : undefined)
      const where = combineWhere(
        filters ? buildFilterSQL(filters, columnMap(model.table)) : undefined,
        accessWhere(model, accessFilter),
      )
      const [totals, buckets] = await Promise.all([
        db
          .select({ value: reducer.as('value') })
          .from(model.table)
          .where(where),
        groupBy ? aggregateBuckets(model, query, groupBy, reducer, where) : [],
      ])

      return { value: toNumber(totals[0]?.value), buckets }
    },

    async list(name, query): Promise<PagedResult> {
      const model = modelOf(name)
      const { select, joins, relationKeys } = buildSelection(base, model)
      const indexedText = model.model.options.storage?.fields?.text
      const searchable = Object.keys(tableColumns(model.table)).filter(
        (key) =>
          (!model.fieldSpecs[key]?.spec.serverOnly || key === indexedText) &&
          (!listFields || listFields.includes(key)),
      )
      const where = combineWhere(
        query.search ? searchSQL(model.table, query.search, searchable) : undefined,
        query.filters ? buildFilterSQL(query.filters, columnMap(model.table)) : undefined,
        accessWhere(model, query.accessFilter),
      )

      const columns = tableColumns(model.table)
      const idCol = columns['id']
      const sortCol = (query.sortBy ? columns[query.sortBy] : undefined) ?? idCol
      const sortOrder = query.sortDir === 'desc' ? desc : asc
      const orderBy = sortCol ? sortOrder(sortCol) : undefined
      const offset = (query.page - 1) * query.pageSize

      const projection = listFields
        ? Object.fromEntries(Object.entries(select).filter(([key]) => listFields.includes(key)))
        : select
      let listQuery = db.select(projection).from(model.table).$dynamic()
      let countQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(model.table)
        .$dynamic()
      for (const join of joins) listQuery = listQuery.leftJoin(join.table, join.on)
      if (where) {
        listQuery = listQuery.where(where)
        countQuery = countQuery.where(where)
      }
      // Equal sort values must not move between pages across requests.
      if (orderBy) {
        listQuery = listQuery.orderBy(
          ...(idCol && sortCol !== idCol ? [orderBy, asc(idCol)] : [orderBy]),
        )
      }
      listQuery = listQuery.limit(query.pageSize).offset(offset)

      const [rows, countRows] = await Promise.all([listQuery, countQuery])
      const totalCount = Number(countRows[0]?.count ?? 0)
      const data = rows.map((row) => nestRow(row, relationKeys))

      return {
        data,
        totalCount,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(totalCount / query.pageSize)),
      }
    },

    find: (name, id, accessFilter) => find(modelOf(name), id, accessFilter),

    exists: (name, id, accessFilter) => exists(modelOf(name), id, accessFilter),

    async create(name, values): Promise<Record<string, unknown> | undefined> {
      const model = modelOf(name)
      const inserted = await db.insert(model.table).values(values).returning()
      const row = inserted[0]
      if (!row || row['id'] == null) return undefined
      return find(model, Number(row['id']))
    },

    async update(
      name,
      id,
      patch,
      accessFilter,
      expected,
    ): Promise<Record<string, unknown> | undefined> {
      const model = modelOf(name)
      const columns = tableColumns(model.table)
      const idCol = columns['id']
      if (!idCol) return undefined
      const snapshot = Object.entries(expected ?? {}).flatMap(([key, value]) => {
        const column = columns[key]
        return column ? [value === null ? isNull(column) : eq(column, value)] : []
      })
      const where = combineWhere(eq(idCol, id), accessWhere(model, accessFilter), ...snapshot)
      const changed = await db.update(model.table).set(patch).where(where).returning({ id: idCol })
      if (!changed.length) return undefined
      return find(model, id, accessFilter)
    },

    async delete(name, id, accessFilter): Promise<boolean> {
      const model = modelOf(name)
      const idCol = tableColumns(model.table)['id']
      if (!idCol) return false
      const where = combineWhere(eq(idCol, id), accessWhere(model, accessFilter))
      const existed = await exists(model, id, accessFilter)
      if (!existed) return false
      await db.delete(model.table).where(where)
      return true
    },
  }
}

/**
 * Wrap a connection-level `DbProvider` (the drivers under `cloudconfig/drivers/*`)
 * into the data-access port. This is the default path: driver → drizzle
 * database → drizzle-sqlite adapter.
 */
export function drizzleSqliteProvider(base: CompiledBase, provider: DbProvider): DataProvider {
  return {
    id: `drizzle-sqlite(${provider.id})`,
    async connect(ctx): Promise<DataAdapter> {
      return drizzleSqliteAdapter(base, await provider.connect(ctx))
    },
  }
}
