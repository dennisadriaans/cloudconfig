/**
 * Parses list query-string params into a normalized shape. Public param names
 * only (no legacy aliases): page, pageSize, search, sortBy, sortDir, filters.
 */
import type { FilterGroup, FilterNode, FilterOperator, FilterValue } from '../index.js'
import {
  AGGREGATE_INTERVALS,
  AGGREGATE_OPS,
  DEFAULT_AGGREGATE_LIMIT,
  MAX_AGGREGATE_LIMIT,
  type AggregateInterval,
  type AggregateOp,
} from '../shared/aggregate.js'
import type { AggregateQuery, ListQuery } from './ports.js'

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 200
export class ListQueryError extends Error {}
export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'is_any_of',
  'is_none_of',
  'like',
  'not_contains',
  'starts_with',
  'ends_with',
  'gt',
  'lt',
  'gte',
  'lte',
  'is_empty',
  'is_not_empty',
] as const satisfies readonly FilterOperator[]
const operators = new Set<FilterOperator>(FILTER_OPERATORS)

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseFilters(raw: string | undefined): FilterGroup | undefined {
  if (!raw) return undefined
  let count = 0
  function node(value: unknown, depth: number): FilterNode {
    if (++count > 100 || depth > 8 || !value || typeof value !== 'object') {
      throw new ListQueryError('Invalid or overly complex filters.')
    }
    const candidate = value as Record<string, unknown>
    if (
      candidate['type'] === 'group' &&
      (candidate['logic'] === 'and' || candidate['logic'] === 'or') &&
      Array.isArray(candidate['children'])
    ) {
      return {
        type: 'group',
        logic: candidate['logic'],
        children: candidate['children'].map((child) => node(child, depth + 1)),
      }
    }
    const val = candidate['value']
    const validValue =
      val === null ||
      typeof val === 'string' ||
      typeof val === 'boolean' ||
      (typeof val === 'number' && Number.isFinite(val)) ||
      (Array.isArray(val) &&
        val.length <= 200 &&
        val.every(
          (item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)),
        ))
    if (
      candidate['type'] !== 'condition' ||
      typeof candidate['field'] !== 'string' ||
      !operators.has(candidate['operator'] as FilterOperator) ||
      !validValue
    ) {
      throw new ListQueryError('Invalid filter condition.')
    }
    const membership =
      candidate['operator'] === 'is_any_of' || candidate['operator'] === 'is_none_of'
    if (membership ? !Array.isArray(val) || val.length === 0 : Array.isArray(val)) {
      throw new ListQueryError('Invalid value for filter operator.')
    }
    return {
      type: 'condition',
      field: candidate['field'],
      operator: candidate['operator'] as FilterOperator,
      value: val as FilterValue,
    }
  }
  try {
    if (raw.length > 20_000) throw new ListQueryError('Filters are too large.')
    const parsed = node(JSON.parse(raw), 0)
    if (parsed.type !== 'group') throw new ListQueryError('Filters must be a group.')
    return parsed
  } catch (cause) {
    throw cause instanceof ListQueryError ? cause : new ListQueryError('Invalid filters JSON.')
  }
}

export function parseListParams(url: URL): ListQuery {
  const searchParams = url.searchParams
  const page = Math.max(1, toInt(searchParams.get('page') ?? undefined, 1))
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, toInt(searchParams.get('pageSize') ?? undefined, DEFAULT_PAGE_SIZE)),
  )
  const search = searchParams.get('search')?.trim() || undefined
  const sortBy = searchParams.get('sortBy') || undefined
  const sortDir = searchParams.get('sortDir') === 'desc' ? 'desc' : 'asc'
  const filters = parseFilters(searchParams.get('filters') ?? undefined)

  return {
    page,
    pageSize,
    sortDir,
    ...(search !== undefined ? { search } : {}),
    ...(sortBy !== undefined ? { sortBy } : {}),
    ...(filters !== undefined ? { filters } : {}),
  }
}

function isAggregateOp(value: string): value is AggregateOp {
  return AGGREGATE_OPS.some((op) => op === value)
}

function isAggregateInterval(value: string): value is AggregateInterval {
  return AGGREGATE_INTERVALS.some((interval) => interval === value)
}

export function parseAggregateParams(url: URL): AggregateQuery {
  const searchParams = url.searchParams
  const op = searchParams.get('op') ?? 'count'
  const interval = searchParams.get('interval') || undefined
  const field = searchParams.get('field') || undefined
  const groupBy = searchParams.get('groupBy') || undefined
  const filters = parseFilters(searchParams.get('filters') ?? undefined)

  if (!isAggregateOp(op)) {
    throw new ListQueryError(`op must be one of ${AGGREGATE_OPS.join(', ')}.`)
  }
  if (interval !== undefined && !isAggregateInterval(interval)) {
    throw new ListQueryError(`interval must be one of ${AGGREGATE_INTERVALS.join(', ')}.`)
  }

  return {
    op,
    limit: Math.min(
      MAX_AGGREGATE_LIMIT,
      Math.max(1, toInt(searchParams.get('limit') ?? undefined, DEFAULT_AGGREGATE_LIMIT)),
    ),
    ...(field !== undefined ? { field } : {}),
    ...(groupBy !== undefined ? { groupBy } : {}),
    ...(interval !== undefined ? { interval } : {}),
    ...(filters !== undefined ? { filters } : {}),
  }
}
