/**
 * Compiles a portable FilterGroup AST (the same shape DashboardStack accepts on
 * the `filters=` query param) into a drizzle SQL expression. Ported from
 * DashboardStack's `buildFilterSQL`, with the "unknown field silently ignored"
 * guard intact so a client can't enumerate columns via crafted filters.
 */
import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type Column,
  type SQL,
} from 'drizzle-orm'
import type { FilterNode } from '../index.js'
import { ListQueryError } from './list-query.js'

export function buildFilterSQL(
  node: FilterNode,
  columnMap: Record<string, Column>,
): SQL | undefined {
  if (node.type === 'group') {
    const parts: SQL[] = []
    for (const child of node.children) {
      const compiled = buildFilterSQL(child, columnMap)
      if (compiled) parts.push(compiled)
    }
    if (parts.length === 0) return undefined
    if (parts.length === 1) return parts[0]
    return node.logic === 'or' ? or(...parts) : and(...parts)
  }

  // Unknown fields are silently ignored (no column enumeration via filters).
  const col = columnMap[node.field]
  if (!col) return undefined

  // Auth timestamps need Date objects; JSON filters arrive as strings or numbers.
  const columnValue = (value: string | number | boolean | null) => {
    if (col.dataType !== 'date' || value === null) return value
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new ListQueryError(`${node.field} requires a valid date.`)
    }
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) {
      throw new ListQueryError(`${node.field} requires a valid date.`)
    }
    return date
  }
  const val = node.value
  const listVal = Array.isArray(val) ? val.map(columnValue) : undefined
  const scalarVal = Array.isArray(val) ? undefined : columnValue(val)

  switch (node.operator) {
    case 'eq':
      return scalarVal === null || scalarVal === undefined ? isNull(col) : eq(col, scalarVal)
    case 'neq':
      return scalarVal === null || scalarVal === undefined ? isNotNull(col) : ne(col, scalarVal)
    case 'is_any_of':
      return listVal && listVal.length > 0 ? inArray(col, listVal) : undefined
    case 'is_none_of':
      return listVal && listVal.length > 0 ? notInArray(col, listVal) : undefined
    case 'like':
      return scalarVal == null ? undefined : like(col, `%${String(scalarVal)}%`)
    case 'not_contains':
      return scalarVal == null ? undefined : not(like(col, `%${String(scalarVal)}%`))
    case 'starts_with':
      return scalarVal == null ? undefined : like(col, `${String(scalarVal)}%`)
    case 'ends_with':
      return scalarVal == null ? undefined : like(col, `%${String(scalarVal)}`)
    case 'gt':
      return scalarVal == null ? undefined : gt(col, scalarVal)
    case 'gte':
      return scalarVal == null ? undefined : gte(col, scalarVal)
    case 'lt':
      return scalarVal == null ? undefined : lt(col, scalarVal)
    case 'lte':
      return scalarVal == null ? undefined : lte(col, scalarVal)
    case 'is_empty':
      return isNull(col)
    case 'is_not_empty':
      return isNotNull(col)
    default:
      return undefined
  }
}
