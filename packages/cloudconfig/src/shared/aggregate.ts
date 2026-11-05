export const AGGREGATE_OPS = ['count', 'sum', 'avg', 'min', 'max'] as const
export const AGGREGATE_INTERVALS = ['day', 'week', 'month'] as const

export const DEFAULT_AGGREGATE_LIMIT = 100
export const MAX_AGGREGATE_LIMIT = 1000

export type AggregateOp = (typeof AGGREGATE_OPS)[number]
export type AggregateInterval = (typeof AGGREGATE_INTERVALS)[number]

/** One group of an aggregate. */
export interface AggregateBucket {
  /**
   * The grouped value: the column's value, or the first day of the period for a date column.
   *
   * Periods are UTC; a week starts on Monday and a month is written `YYYY-MM`.
   */
  key: string | number | boolean | null
  /** The related record's title, when grouping by a relation. */
  label?: string
  value: number | null
}

/** The aggregate response envelope. */
export interface AggregateResult {
  /** The aggregate over every matching row, including rows beyond `limit`. */
  value: number | null
  /** Empty without `groupBy`. Periods run oldest first, other groups largest first. */
  buckets: AggregateBucket[]
}
