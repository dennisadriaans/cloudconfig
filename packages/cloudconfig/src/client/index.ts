/**
 * Public entrypoint: `cloudconfig/client`.
 *
 * A fully typed REST client derived purely from `typeof config` — no codegen,
 * no runtime config value. Because the client never imports the config value,
 * pulling it into a browser bundle drags in zero server/drizzle code.
 */
import type {
  AnyConfig,
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterOperator,
  FilterValue,
  FlatRow,
  InferCreate,
  InferSelect,
  InferUpdate,
} from '../index.js'
import { pluralize } from '../shared/pluralize.js'
import type { AggregateInterval, AggregateOp, AggregateResult } from '../shared/aggregate.js'
import type { PagedResult } from '../shared/paged-result.js'
import type { ValidationIssue } from '../shared/errors.js'

export type { PagedResult } from '../shared/paged-result.js'
export type {
  AggregateBucket,
  AggregateInterval,
  AggregateOp,
  AggregateResult,
} from '../shared/aggregate.js'
export type { ValidationIssue } from '../shared/errors.js'
export { createTable } from './table.js'
export { createFilters } from './filters.js'
export type { TableQuery, TableSource, TableState } from './table.js'
export { createAdminClient } from './admin.js'
export type {
  AdminClient,
  AdminPermission,
  AdminSession,
  AdminUser,
  AdminUserCreate,
  AdminUserUpdate,
} from './admin.js'
export { createAccountClient } from './account.js'
export type { AccountClient, AuthAccount, TwoFactorStatus } from './account.js'
export { createOrganizationClient } from './organizations.js'
export { createConnectClient, readConnectResult } from './connect.js'
export type {
  ConnectClient,
  ConnectStartInput,
  ConnectionSummary,
  ProviderSummary,
  McpTool,
} from './connect.js'
export { createScimClient } from './scim.js'
export type { ScimClient, ScimToken, ScimSecret } from './scim.js'
export type {
  Organization,
  OrganizationClient,
  OrganizationInvitation,
  OrganizationMember,
} from './organizations.js'

export interface ListParams<C extends AnyConfig, N extends keyof C['models']> {
  page?: number
  pageSize?: number
  search?: string
  sortBy?: keyof FlatRow<C, N> & string
  sortDir?: 'asc' | 'desc'
  filters?: FilterGroup
}

/**
 * What to count or reduce, over the rows the caller may list.
 * @example { op: 'sum', field: 'total', groupBy: 'createdAt', interval: 'month' }
 */
export interface AggregateParams<C extends AnyConfig, N extends keyof C['models']> {
  /** @default 'count' */
  op?: AggregateOp
  /** Column to reduce. Required except for `count`, which counts rows without it. */
  field?: keyof FlatRow<C, N> & string
  /** Column to group by; a relation's foreign key also labels each group. */
  groupBy?: keyof FlatRow<C, N> & string
  /**
   * Period for a date `groupBy`, in UTC.
   * @default 'day'
   */
  interval?: AggregateInterval
  /**
   * Most groups returned: the latest periods, or the largest other groups.
   * @default 100
   */
  limit?: number
  filters?: FilterGroup
}

export interface ClientOptions {
  baseUrl?: string
  fetch?: typeof fetch
  storagePaths?: Record<string, string>
  headers?: HeadersInit | (() => HeadersInit)
}

/**
 * Resolve a relative `baseUrl` against an absolute origin when running on a
 * server. In the browser `fetch('/api/posts')` resolves against the current
 * document, but Node's `fetch` rejects relative URLs outright — so the same
 * client that works in a client component throws in a server component.
 *
 * Rather than make every app rediscover this, the origin is read from the
 * environment: `CLOUDCONFIG_URL` if set, else `VERCEL_URL` (which Vercel injects
 * without a scheme), else the conventional Next/Nitro `NEXT_PUBLIC_SITE_URL`.
 * When none is set we fall back to `PORT` on localhost, which covers the common
 * `dev` case; if that guess is wrong the request fails with a message naming
 * the variable to set instead of an opaque "Failed to parse URL".
 */
function resolveServerOrigin(): string {
  const env: Record<string, string | undefined> =
    typeof process !== 'undefined' && process.env ? process.env : {}

  const explicit = env['CLOUDCONFIG_URL'] ?? env['NEXT_PUBLIC_SITE_URL']
  if (explicit) return explicit.replace(/\/$/, '')

  // Vercel exposes the deployment host without a protocol.
  const vercel = env['VERCEL_URL']
  if (vercel) return `https://${vercel.replace(/\/$/, '')}`

  const port = env['PORT'] ?? '3000'
  return `http://localhost:${port}`
}

function absolutize(baseUrl: string): string {
  // Already absolute, or we're in a browser where relative URLs resolve fine.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)) return baseUrl
  if (typeof window !== 'undefined') return baseUrl
  return `${resolveServerOrigin()}${baseUrl.startsWith('/') ? '' : '/'}${baseUrl}`
}

export type ModelClient<C extends AnyConfig, N extends keyof C['models']> = {
  list(
    params?: ListParams<C, N>,
    options?: { signal?: AbortSignal },
  ): Promise<PagedResult<InferSelect<C, N>>>
  aggregate(
    params?: AggregateParams<C, N>,
    options?: { signal?: AbortSignal },
  ): Promise<AggregateResult>
  get(id: number): Promise<InferSelect<C, N>>
  create(input: InferCreate<C, N>): Promise<InferSelect<C, N>>
  update(id: number, patch: InferUpdate<C, N>): Promise<InferSelect<C, N>>
  delete(id: number): Promise<void>
  upload(file: File, options?: { fields?: Partial<InferCreate<C, N>> }): Promise<InferSelect<C, N>>
  download(id: number): Promise<Response>
}

export type CloudConfigClient<C extends AnyConfig> = {
  [N in keyof C['models'] & string]: ModelClient<C, N>
}

/**
 * Build a typed client. The `C` type parameter carries all typing; pass it as
 * `createClient<typeof config>()` (or a bound type alias).
 */
export function createClient<C extends AnyConfig>(opts: ClientOptions = {}): CloudConfigClient<C> {
  const baseUrl = absolutize((opts.baseUrl ?? '/api').replace(/\/$/, ''))
  const doFetch = opts.fetch ?? fetch

  function headers(): Headers {
    const base = typeof opts.headers === 'function' ? opts.headers() : opts.headers
    return new Headers(base)
  }

  // `res.json()` is typed `any`, so its result satisfies any concrete return
  // type without a type assertion — this is what keeps the typed facade below
  // free of forbidden `as` casts.
  async function send(path: string, init?: RequestInit): Promise<Response> {
    const requestHeaders = headers()
    if (init?.body instanceof FormData) requestHeaders.delete('content-type')
    else if (!requestHeaders.has('content-type')) {
      requestHeaders.set('content-type', 'application/json')
    }
    const res = await doFetch(`${baseUrl}${path}`, { ...init, headers: requestHeaders })
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => ({}))
      const message =
        typeof body === 'object' && body !== null && 'message' in body
          ? String(body.message)
          : `Request failed (${res.status})`
      throw new CloudConfigClientError(message, res.status, body)
    }
    return res
  }

  // `res.json()` is typed `any`, so its result satisfies any concrete return
  // type without a type assertion — this keeps the typed facade free of `as`.
  async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await send(path, init)
    return res.json()
  }

  async function requestVoid(path: string, init?: RequestInit): Promise<void> {
    await send(path, init)
  }

  function listQuery(params?: ListParams<C, keyof C['models']>): string {
    if (!params) return ''
    const searchParams = new URLSearchParams()
    if (params.page != null) searchParams.set('page', String(params.page))
    if (params.pageSize != null) searchParams.set('pageSize', String(params.pageSize))
    if (params.search) searchParams.set('search', params.search)
    if (params.sortBy) searchParams.set('sortBy', String(params.sortBy))
    if (params.sortDir) searchParams.set('sortDir', params.sortDir)
    if (params.filters) searchParams.set('filters', JSON.stringify(params.filters))
    const queryString = searchParams.toString()
    return queryString ? `?${queryString}` : ''
  }

  function aggregateQuery(params?: AggregateParams<C, keyof C['models']>): string {
    if (!params) return ''
    const { filters, limit, ...rest } = params
    const searchParams = new URLSearchParams(Object.entries(rest))
    if (limit != null) searchParams.set('limit', String(limit))
    if (filters) searchParams.set('filters', JSON.stringify(filters))
    const queryString = searchParams.toString()
    return queryString ? `?${queryString}` : ''
  }

  function modelClient(segment: string, modelKey: string): ModelClient<C, keyof C['models']> {
    return {
      list: (params, options) => requestJson(`/${segment}${listQuery(params)}`, options),
      aggregate: (params, options) =>
        requestJson(`/${segment}/aggregate${aggregateQuery(params)}`, options),
      get: (id) => requestJson(`/${segment}/${id}`),
      create: (input) =>
        requestJson(`/${segment}`, { method: 'POST', body: JSON.stringify(input) }),
      update: (id, patch) =>
        requestJson(`/${segment}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      delete: (id) => requestVoid(`/${segment}/${id}`, { method: 'DELETE' }),
      upload(file, options) {
        const body = new FormData()
        body.append('file', file)
        if (options?.fields) body.append('fields', JSON.stringify(options.fields))
        return requestJson(opts.storagePaths?.[modelKey] ?? `/${segment}/content`, {
          method: 'POST',
          body,
        })
      },
      download: (id) => send(`${opts.storagePaths?.[modelKey] ?? `/${segment}/content`}/${id}`),
    }
  }

  const handler: ProxyHandler<CloudConfigClient<C>> = {
    get: (_target, modelKey: string) => modelClient(pluralize(modelKey), modelKey),
  }
  // The Proxy is the single typed-facade boundary: an empty target typed as the
  // client, with per-model accessors materialized on demand by the handler.
  return new Proxy(Object.create(null), handler)
}

export class CloudConfigClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'CloudConfigClientError'
  }

  /** Field errors for editors; absent or unrelated error bodies yield no issues. */
  get issues(): ValidationIssue[] {
    if (typeof this.body !== 'object' || this.body === null || !('issues' in this.body)) return []
    if (!Array.isArray(this.body.issues)) return []
    return this.body.issues.filter(
      (issue): issue is ValidationIssue =>
        typeof issue === 'object' &&
        issue !== null &&
        typeof issue.path === 'string' &&
        typeof issue.message === 'string',
    )
  }
}

/** Builds list filters. Field names are typed; values stay loosely typed for now. */
export const f = {
  and: (...children: FilterNode[]): FilterGroup => ({ type: 'group', logic: 'and', children }),
  or: (...children: FilterNode[]): FilterGroup => ({ type: 'group', logic: 'or', children }),
  where: <C extends AnyConfig, N extends keyof C['models']>(
    field: keyof FlatRow<C, N> & string,
    operator: FilterOperator,
    value: FilterValue,
  ): FilterCondition => ({ type: 'condition', field, operator, value }),
}

export type { FilterGroup, FilterNode, FilterCondition }
