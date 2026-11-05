import type { FilterCondition, FilterGroup, FilterNode, FilterValue } from '../dsl/filters.js'

type Scalar = string | number | boolean
type Keys<Row> = { [K in keyof Row]: NonNullable<Row[K]> extends Scalar ? K : never }[keyof Row] &
  string
type Condition<Value> =
  | [operator: 'eq' | 'neq', value: Extract<Value, Scalar | null>]
  | [operator: 'is_empty' | 'is_not_empty']
  | (NonNullable<Value> extends string
      ? [operator: 'like' | 'not_contains' | 'starts_with' | 'ends_with', value: string]
      : never)
  | (NonNullable<Value> extends string | number
      ? [operator: 'gt' | 'gte' | 'lt' | 'lte', value: NonNullable<Value>]
      : never)
  | (NonNullable<Value> extends string | number
      ? [operator: 'is_any_of' | 'is_none_of', value: NonNullable<Value>[]]
      : never)

/** Field names, operators, and values are checked against the supplied row type. */
export function createFilters<Row>() {
  return {
    and: (...children: FilterNode[]): FilterGroup => ({ type: 'group', logic: 'and', children }),
    or: (...children: FilterNode[]): FilterGroup => ({ type: 'group', logic: 'or', children }),
    where<Key extends Keys<Row>>(field: Key, ...condition: Condition<Row[Key]>): FilterCondition {
      const [operator, value] = condition
      return { type: 'condition', field, operator, value: (value ?? null) as FilterValue }
    },
  }
}
