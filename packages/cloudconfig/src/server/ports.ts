/**
 * The ports of the hexagon — the seams a user with different stack
 * requirements can realistically swap. Everything here is expressed in
 * portable terms (plain records, the FilterNode AST, web-standard Request):
 * no drizzle, no zod, no hono. Implementations live in `adapters/` and
 * `drivers/`; the core (`operations.ts`) depends only on these types.
 *
 * File storage uses platform bindings independently of the data adapter.
 */
import type { FilterGroup, FilterNode } from '../index.js'
import type { AggregateInterval, AggregateOp, AggregateResult } from '../shared/aggregate.js'
import type { PagedResult } from '../shared/paged-result.js'

export type { PagedResult } from '../shared/paged-result.js'
export type {
  AggregateBucket,
  AggregateInterval,
  AggregateOp,
  AggregateResult,
} from '../shared/aggregate.js'

/**
 * The keys projected onto a nested relation object in wire-shaped rows
 * (DashboardStack's label + image vocabulary). Every adapter uses this same
 * set so swapping the data stack never changes response shapes.
 */
export const RELATION_PROJECTION_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'title',
  'label',
  'email',
  'slug',
  'image',
  'avatar',
  'logo',
])

/** Per-request platform context handed to a provider's `connect`. */
export interface ConnectContext {
  /** Platform bindings (e.g. Cloudflare `env` with a D1 `DB` binding). */
  env: Record<string, unknown> | undefined
  request: Request
}

/** A normalized list request, as the core hands it to an adapter. */
export interface ListQuery {
  page: number
  pageSize: number
  search?: string
  sortBy?: string
  sortDir: 'asc' | 'desc'
  filters?: FilterGroup
}

/** `ListQuery` plus the row-level predicate access rules produced. */
export interface AdapterListQuery extends ListQuery {
  /** Extra predicate from access rules, AND'ed into every query. */
  accessFilter?: FilterNode
}

/** A normalized aggregate request, as the core hands it to `Operations.aggregate`. */
export interface AggregateQuery {
  op: AggregateOp
  /** Column to reduce. Required except for `count`, which counts rows without it. */
  field?: string
  /** Column to group by; a relation's foreign key also labels each group. */
  groupBy?: string
  /** Period for a date `groupBy`; defaults to `day`. */
  interval?: AggregateInterval
  /** Most groups returned: the latest periods, or the largest other groups. */
  limit: number
  filters?: FilterGroup
}

/** `AggregateQuery` plus the row-level predicate access rules produced. */
export interface AdapterAggregateQuery extends AggregateQuery {
  /** Extra predicate from access rules, AND'ed into every query. */
  accessFilter?: FilterNode
}

/**
 * The data-access port. One implementation per storage stack — the built-in
 * one is drizzle-on-SQLite (`adapters/drizzle-sqlite.ts`); a Postgres or
 * different-ORM stack implements this same interface and nothing above it
 * changes.
 *
 * Contracts an implementation must honor (the in-memory fixture in
 * `test/memory-provider.ts` is a worked example of all of them):
 * - `model` is the singular model key from the config (`base.models[model]`).
 * - Returned rows are in wire shape: belongs-to relations expanded to nested
 *   objects (`author: { id, name, … } | null`, projecting only
 *   `RELATION_PROJECTION_KEYS`) with the raw FK column omitted.
 * - `accessFilter` predicates AND into every read/write; a mutation on a row
 *   outside the predicate behaves as if the row doesn't exist.
 * - `create`/`update` receive final column values (timestamps already
 *   injected by the core) and return the fresh wire-shaped row. Schema
 *   defaults from the config apply when a create omits the column.
 * - Lists fall back to ordering by `id` when `sortBy` is absent (`sortDir`
 *   still applies), so pagination is deterministic on every engine.
 * - `aggregate` receives a validated query: `field` is numeric unless the op is
 *   `count`, and `interval` is set exactly when `groupBy` is a date column. A
 *   `sum` over no rows is 0; `avg`, `min` and `max` are null.
 */
export interface DataAdapter {
  list(model: string, query: AdapterListQuery): Promise<PagedResult>
  aggregate(model: string, query: AdapterAggregateQuery): Promise<AggregateResult>
  find(
    model: string,
    id: number,
    accessFilter?: FilterNode,
  ): Promise<Record<string, unknown> | undefined>
  /** Does a row exist matching id AND the access predicate? Gates mutations. */
  exists(model: string, id: number, accessFilter?: FilterNode): Promise<boolean>
  create(
    model: string,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>
  update(
    model: string,
    id: number,
    patch: Record<string, unknown>,
    accessFilter?: FilterNode,
    /** When supplied, atomically write only if these persisted values still match. */
    expected?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>
  delete(model: string, id: number, accessFilter?: FilterNode): Promise<boolean>
}

/**
 * Factory for per-request `DataAdapter`s. Schema knowledge is construction
 * time (an implementation closes over the compiled config); platform bindings
 * are connect time (D1 hands the database over per request).
 */
export interface DataProvider {
  /** Human name for diagnostics, e.g. "drizzle-sqlite", "memory". */
  readonly id: string
  connect(ctx: ConnectContext): DataAdapter | Promise<DataAdapter>
}

/** What the transport knows about the platform when it resolves an identity. */
export interface GetUserContext {
  /** Platform bindings (e.g. Cloudflare `env`), where the secrets live. */
  env: Record<string, unknown> | undefined
}

/**
 * The identity port. A function is the whole interface: resolve the caller
 * from the request (cookie, bearer token, session lookup — your choice).
 * Swap auth stacks by swapping this function.
 *
 * The second argument carries the platform env, because on Cloudflare that is
 * the only place a session secret exists. Implementations are free to ignore it.
 */
export type GetUser<TUser = unknown> = (
  request: Request,
  ctx: GetUserContext,
) => TUser | null | Promise<TUser | null>
