import type { FilterGroup } from '../dsl/filters.js'
import type { PagedResult } from '../shared/paged-result.js'

export interface TableQuery<Key extends string = string> {
  page?: number
  pageSize?: number
  search?: string
  sortBy?: Key
  sortDir?: 'asc' | 'desc'
  filters?: FilterGroup
}

export interface TableSource<Row, Create, Update, Key extends string> {
  list(query?: TableQuery<Key>, options?: { signal?: AbortSignal }): Promise<PagedResult<Row>>
  create(input: Create): Promise<Row>
  update(id: number, input: Update): Promise<Row>
  delete(id: number): Promise<void>
}

export interface TableState<Row, Key extends string> {
  query: TableQuery<Key>
  result: PagedResult<Row>
  pending: boolean
  saving: boolean
  error: Error | null
  mutationError: Error | null
  loaded: boolean
}

function errorOf(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(max, Math.max(1, Math.floor(value)))
    : fallback
}

/** A per-view controller; never share an instance between server requests. */
export function createTable<Row, Create, Update, Key extends string>(
  source: TableSource<Row, Create, Update, Key>,
  initial: NoInfer<TableQuery<Key>> = {},
) {
  const query = {
    ...initial,
    page: bounded(initial.page, 1, Number.MAX_SAFE_INTEGER),
    pageSize: bounded(initial.pageSize, 20, 200),
  }
  let state: TableState<Row, Key> = {
    query,
    result: { data: [], totalCount: 0, totalPages: 1, page: query.page, pageSize: query.pageSize },
    pending: false,
    saving: false,
    error: null,
    mutationError: null,
    loaded: false,
  }
  const listeners = new Set<(state: TableState<Row, Key>) => void>()
  let request: AbortController | undefined
  let revision = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function publish(patch: Partial<TableState<Row, Key>>) {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  async function refresh(): Promise<PagedResult<Row> | undefined> {
    if (disposed) return
    clearTimeout(timer)
    request?.abort()
    const current = ++revision
    const controller = new AbortController()
    request = controller
    publish({ pending: true, error: null })
    try {
      let result = await source.list(state.query, { signal: controller.signal })
      if (disposed || current !== revision) return
      if (result.page > result.totalPages) {
        publish({ query: { ...state.query, page: Math.max(1, result.totalPages) } })
        result = await source.list(state.query, { signal: controller.signal })
      }
      if (disposed || current !== revision) return
      publish({ result, loaded: true })
      return result
    } catch (cause) {
      if (!disposed && current === revision) publish({ error: errorOf(cause), loaded: true })
    } finally {
      if (current === revision) publish({ pending: false })
    }
  }

  function setQuery(patch: TableQuery<Key>) {
    publish({
      query: {
        ...state.query,
        ...patch,
        page: bounded(patch.page, 1, Number.MAX_SAFE_INTEGER),
        pageSize: bounded(patch.pageSize ?? state.query.pageSize, 20, 200),
      },
    })
    return refresh()
  }

  async function mutate<T>(action: () => Promise<T>): Promise<T> {
    if (disposed) throw new Error('This table has been disposed.')
    if (state.saving) throw new Error('A change is already being saved.')
    publish({ saving: true, mutationError: null })
    try {
      const result = await action()
      // A successful write remains successful even if its subsequent refresh fails.
      await refresh()
      return result
    } catch (cause) {
      const error = errorOf(cause)
      publish({ mutationError: error })
      throw error
    } finally {
      publish({ saving: false })
    }
  }

  return {
    get state() {
      return state
    },
    subscribe(listener: (state: TableState<Row, Key>) => void) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },
    hydrate(
      result: PagedResult<Row>,
      error: Error | null = null,
      query: TableQuery<Key> = state.query,
    ) {
      publish({ result, query, error, loaded: true, pending: false })
    },
    refresh,
    setQuery,
    setPage: (page: number) => setQuery({ page }),
    setPageSize: (pageSize: number) => setQuery({ pageSize }),
    setSort: (sortBy: Key, sortDir: 'asc' | 'desc' = 'asc') => setQuery({ sortBy, sortDir }),
    setFilters: (filters: FilterGroup) => setQuery({ filters }),
    setSearch(search: string, delay = 250) {
      clearTimeout(timer)
      request?.abort()
      ++revision
      publish({ query: { ...state.query, search, page: 1 }, pending: true, error: null })
      timer = setTimeout(() => {
        void refresh()
      }, delay)
    },
    create: (input: Create) => mutate(() => source.create(input)),
    update: (id: number, input: Update) => mutate(() => source.update(id, input)),
    delete: (id: number) => mutate(() => source.delete(id)),
    dispose() {
      disposed = true
      ++revision
      clearTimeout(timer)
      request?.abort()
      listeners.clear()
    },
  }
}
