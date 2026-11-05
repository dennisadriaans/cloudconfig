/**
 * Test fixture: a complete in-memory implementation of the data-access port,
 * honoring every contract the built-in drizzle adapter does (wire-shaped rows,
 * relation nesting, schema defaults, portable FilterNode evaluation,
 * access-predicate AND semantics).
 *
 * It exists so `createBackend(config, { data })` — the seam that lets an app
 * swap the whole data stack — is exercised against something that is not
 * drizzle. Not shipped: it is a fixture, not public API.
 */
import type { AnyConfig, FilterNode } from '../src/index.js'
import { compileConfig, type CompiledModel } from '../src/server/compile/index.js'
import {
  RELATION_PROJECTION_KEYS,
  type DataAdapter,
  type DataProvider,
  type PagedResult,
} from '../src/server/ports.js'

type Row = Record<string, unknown>

/**
 * Evaluate a portable FilterNode against a row, with the same semantics the
 * SQL compiler (`filters-sql.ts`) gives it: unknown fields are silently
 * ignored (no column enumeration), string matching is case-insensitive like
 * SQLite's LIKE, and comparisons against null never match.
 */
export function matchesFilter(
  row: Row,
  node: FilterNode,
  knownColumns?: ReadonlySet<string>,
): boolean {
  return evalNode(row, node, knownColumns) ?? true
}

function evalNode(row: Row, node: FilterNode, known?: ReadonlySet<string>): boolean | undefined {
  if (node.type === 'group') {
    const parts: boolean[] = []
    for (const child of node.children) {
      const result = evalNode(row, child, known)
      if (result !== undefined) parts.push(result)
    }
    if (parts.length === 0) return undefined
    return node.logic === 'or' ? parts.some(Boolean) : parts.every(Boolean)
  }

  if (known && !known.has(node.field)) return undefined
  const actual = row[node.field]
  const val = node.value
  const list = Array.isArray(val) ? val : undefined
  const scalar = Array.isArray(val) ? undefined : val
  const contains = (haystack: unknown, needle: string): boolean =>
    haystack != null && String(haystack).toLowerCase().includes(needle.toLowerCase())

  switch (node.operator) {
    case 'eq':
      return scalar == null ? actual == null : actual === scalar
    case 'neq':
      return scalar == null ? actual != null : actual != null && actual !== scalar
    case 'is_any_of':
      return list && list.length > 0 ? list.some((v) => v === actual) : undefined
    case 'is_none_of':
      return list && list.length > 0 ? actual != null && !list.some((v) => v === actual) : undefined
    case 'like':
      return scalar == null ? undefined : contains(actual, String(scalar))
    case 'not_contains':
      return scalar == null ? undefined : actual != null && !contains(actual, String(scalar))
    case 'starts_with':
      return scalar == null
        ? undefined
        : actual != null && String(actual).toLowerCase().startsWith(String(scalar).toLowerCase())
    case 'ends_with':
      return scalar == null
        ? undefined
        : actual != null && String(actual).toLowerCase().endsWith(String(scalar).toLowerCase())
    case 'gt':
      return scalar == null ? undefined : compare(actual, scalar) > 0
    case 'gte':
      return scalar == null ? undefined : compare(actual, scalar) >= 0
    case 'lt':
      // NaN (null operand) compares false on every branch, matching SQL NULL.
      return scalar == null ? undefined : compare(actual, scalar) < 0
    case 'lte':
      return scalar == null ? undefined : compare(actual, scalar) <= 0
    case 'is_empty':
      return actual == null
    case 'is_not_empty':
      return actual != null
    default:
      return undefined
  }
}

/** SQL-flavored comparison: null never compares (NaN), numbers numeric, else string order. */
function compare(a: unknown, b: unknown): number {
  if (a == null || b == null) return Number.NaN
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const left = String(a)
  const right = String(b)
  if (left === right) return 0
  return left < right ? -1 : 1
}

export interface MemoryProvider extends DataProvider {
  /** Raw stored rows (column-keyed, FK columns intact) — for assertions in tests. */
  rows(model: string): Row[]
  /** Drop all rows and reset id counters. */
  reset(): void
}

/** Create the in-memory data stack for a config. State lives per provider instance. */
export function memoryProvider(config: AnyConfig): MemoryProvider {
  const base = compileConfig(config)
  const tables = new Map<string, Map<number, Row>>()
  const counters = new Map<string, number>()

  function modelOf(name: string): CompiledModel {
    const model = base.models[name]
    if (!model) throw new Error(`memory adapter: unknown model "${name}"`)
    return model
  }

  function tableOf(name: string): Map<number, Row> {
    let table = tables.get(name)
    if (!table) {
      table = new Map()
      tables.set(name, table)
    }
    return table
  }

  function columnKeys(model: CompiledModel): Set<string> {
    const keys = new Set(['id', ...Object.keys(model.fieldSpecs)])
    if (model.timestamps) {
      keys.add('createdAt')
      keys.add('updatedAt')
    }
    return keys
  }

  /** Raw stored row → wire shape: FK columns dropped, relations nested. */
  function wire(model: CompiledModel, row: Row): Row {
    const fkKeys = new Set(model.relationships.map((rel) => rel.fieldName))
    const out: Row = {}
    for (const [key, value] of Object.entries(row)) {
      if (!fkKeys.has(key)) out[key] = value
    }
    for (const rel of model.relationships) {
      const fk = row[rel.fieldName]
      const target = fk == null ? undefined : tableOf(rel.targetModel).get(Number(fk))
      out[rel.relationKey] = target
        ? Object.fromEntries(
            Object.entries(target).filter(([key]) => RELATION_PROJECTION_KEYS.has(key)),
          )
        : null
    }
    return out
  }

  function select(model: CompiledModel, accessFilter?: FilterNode): Row[] {
    const all = [...tableOf(model.name).values()]
    if (!accessFilter) return all
    const known = columnKeys(model)
    return all.filter((row) => matchesFilter(row, accessFilter, known))
  }

  function reduce(op: string, values: unknown[], rowCount: number): number | null {
    const numbers = values.filter((value) => typeof value === 'number')
    if (op === 'count') return rowCount
    if (op === 'sum') return numbers.reduce((total, value) => total + value, 0)
    if (!numbers.length) return null
    if (op === 'min') return Math.min(...numbers)
    if (op === 'max') return Math.max(...numbers)
    return numbers.reduce((total, value) => total + value, 0) / numbers.length
  }

  const adapter: DataAdapter = {
    async aggregate(name, query) {
      const model = modelOf(name)
      const known = columnKeys(model)
      let rows = select(model, query.accessFilter)
      if (query.filters) rows = rows.filter((row) => matchesFilter(row, query.filters!, known))
      const { op, field, groupBy, limit } = query
      const valueOf = (group: Row[]) =>
        reduce(op, field ? group.map((row) => row[field]) : [], group.length)
      const groups = new Map<unknown, Row[]>()
      for (const row of groupBy ? rows : []) {
        const key = row[groupBy!]
        groups.set(key, [...(groups.get(key) ?? []), row])
      }
      const buckets = [...groups].map(([key, group]) => ({
        key: key === undefined ? null : (key as string | number | boolean | null),
        value: valueOf(group),
      }))
      return { value: valueOf(rows), buckets: buckets.slice(0, limit) }
    },

    async list(name, query): Promise<PagedResult> {
      const model = modelOf(name)
      const known = columnKeys(model)
      let rows = select(model, query.accessFilter)
      if (query.filters) rows = rows.filter((row) => matchesFilter(row, query.filters!, known))
      if (query.search) {
        const term = query.search.toLowerCase()
        rows = rows.filter((row) =>
          Object.entries(row).some(
            ([key, value]) =>
              (!model.fieldSpecs[key]?.spec.serverOnly ||
                key === model.model.options.storage?.fields?.text) &&
              typeof value === 'string' &&
              value.toLowerCase().includes(term),
          ),
        )
      }
      const sortKey = query.sortBy ?? 'id'
      if (known.has(sortKey)) {
        const dir = query.sortDir === 'desc' ? -1 : 1
        rows = [...rows].sort((a, b) => {
          const c = compare(a[sortKey], b[sortKey])
          // nulls sort first, like SQLite ASC
          if (Number.isNaN(c)) return (a[sortKey] == null ? -1 : 1) * dir
          return c * dir
        })
      }
      const totalCount = rows.length
      const start = (query.page - 1) * query.pageSize
      return {
        data: rows.slice(start, start + query.pageSize).map((row) => wire(model, row)),
        totalCount,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.max(1, Math.ceil(totalCount / query.pageSize)),
      }
    },

    async find(name, id, accessFilter) {
      const model = modelOf(name)
      const row = select(model, accessFilter).find((r) => r['id'] === id)
      return row ? wire(model, row) : undefined
    },

    async exists(name, id, accessFilter) {
      return select(modelOf(name), accessFilter).some((row) => row['id'] === id)
    },

    async create(name, values) {
      const model = modelOf(name)
      const id = (counters.get(model.name) ?? 0) + 1
      counters.set(model.name, id)
      const row: Row = { id }
      // Schema defaults apply when a create omits the column (port contract);
      // absent optionals become null, matching SQL storage.
      for (const [key, field] of Object.entries(model.fieldSpecs)) {
        const provided = values[key]
        const fallback = field.spec.hasDefault ? field.spec.defaultValue : null
        row[key] = provided !== undefined ? provided : fallback
      }
      for (const [key, value] of Object.entries(values)) {
        if (!(key in row)) row[key] = value
      }
      tableOf(model.name).set(id, row)
      return wire(model, row)
    },

    async update(name, id, patch, accessFilter, expected) {
      const model = modelOf(name)
      const row = select(model, accessFilter).find((r) => r['id'] === id)
      if (!row) return undefined
      if (
        Object.entries(expected ?? {}).some(
          ([key, value]) => JSON.stringify(row[key]) !== JSON.stringify(value),
        )
      ) {
        return undefined
      }
      const next = { ...row, ...patch }
      tableOf(model.name).set(id, next)
      return wire(model, next)
    },

    async delete(name, id, accessFilter) {
      const model = modelOf(name)
      const row = select(model, accessFilter).find((r) => r['id'] === id)
      if (!row) return false
      tableOf(model.name).delete(id)
      return true
    },
  }

  return {
    id: 'memory',
    connect: () => adapter,
    rows: (model) => [...tableOf(model).values()].map((row) => ({ ...row })),
    reset: () => {
      tables.clear()
      counters.clear()
    },
  }
}
