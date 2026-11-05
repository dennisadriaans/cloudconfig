/** The list response envelope (byte-compatible with DashboardStack). */
export interface PagedResult<T = Record<string, unknown>> {
  data: T[]
  totalCount: number
  page: number
  pageSize: number
  totalPages: number
}
