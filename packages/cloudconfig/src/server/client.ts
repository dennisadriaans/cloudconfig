import type {
  AccessAction,
  AnyConfig,
  InferCreate,
  InferServerSelect,
  InferServerCreate,
} from '../index.js'
import { CloudConfigClientError, type AggregateParams, type ListParams } from '../client/index.js'
import { DEFAULT_AGGREGATE_LIMIT, type AggregateResult } from '../shared/aggregate.js'
import { compileConfig } from './compile/index.js'
import { createAuthRuntime } from './auth/mount.js'
import {
  OP_ERROR_STATUS,
  createOperations,
  getOpErrorFallbackMessage,
  type OperationsOptions,
  type OpResult,
  type RequestContext,
} from './operations.js'
import { pluralize } from '../shared/pluralize.js'
import type { PagedResult } from './ports.js'

export type ServerClient<C extends AnyConfig> = {
  [N in keyof C['models'] & string]: {
    list(query?: ListParams<C, N>): Promise<PagedResult<InferServerSelect<C, N>>>
    aggregate(query?: AggregateParams<C, N>): Promise<AggregateResult>
    get(id: number): Promise<InferServerSelect<C, N>>
    create(input: InferServerCreate<C, N>): Promise<InferServerSelect<C, N>>
    update(id: number, patch: Partial<InferServerCreate<C, N>>): Promise<InferServerSelect<C, N>>
    delete(id: number): Promise<void>
    upload(
      file: File,
      options?: { fields?: Partial<InferCreate<C, N>> },
    ): Promise<InferServerSelect<C, N>>
    retryCleanup(): Promise<{ cleaned: number }>
    /** Preflight: would this caller be allowed to perform `action`, on row `id` when given? */
    can(
      action: AccessAction,
      target?: { id?: number; input?: Record<string, unknown> },
    ): Promise<boolean>
  }
}

/** Direct server calls keep the caller's identity and every access rule. */
export function createServerClient<C extends AnyConfig>(
  config: C,
  context: RequestContext,
  options: OperationsOptions = {},
): ServerClient<C> {
  const base = compileConfig(config)
  const getUser =
    options.getUser ??
    (base.auth
      ? createAuthRuntime(base, base.auth, options.db ? { db: options.db } : {}).getUser
      : undefined)
  const ops = createOperations(config, {
    ...options,
    ...(getUser ? { getUser } : {}),
    authority: 'server',
  })
  async function unwrap<T>(request: Promise<OpResult<T>>): Promise<T> {
    const result = await request
    if (result.ok) return result.value
    const status = OP_ERROR_STATUS[result.code] ?? 404
    const message = result.issues?.[0]?.message ?? getOpErrorFallbackMessage(status)
    throw new CloudConfigClientError(message, status, { message, issues: result.issues })
  }
  return new Proxy(Object.create(null), {
    get: (_, name: string) => {
      const plural = pluralize(name)
      return {
        list: (query: ListParams<C, keyof C['models']> = {}) =>
          unwrap(
            ops.list(context, plural, {
              ...query,
              page: query.page ?? 1,
              pageSize: query.pageSize ?? 20,
              sortDir: query.sortDir ?? 'asc',
            }),
          ),
        aggregate: (query: AggregateParams<C, keyof C['models']> = {}) =>
          unwrap(
            ops.aggregate(context, plural, {
              ...query,
              op: query.op ?? 'count',
              limit: query.limit ?? DEFAULT_AGGREGATE_LIMIT,
            }),
          ),
        get: (id: number) => unwrap(ops.get(context, plural, id)),
        create: (input: unknown) => unwrap(ops.create(context, plural, input)),
        update: (id: number, patch: unknown) => unwrap(ops.update(context, plural, id, patch)),
        upload: (file: File, options?: { fields?: Record<string, unknown> }) =>
          unwrap(ops.upload(context, plural, { file, ...options })),
        retryCleanup: () => unwrap(ops.retryStorageCleanup(context, plural)),
        can: (action: AccessAction, target?: { id?: number; input?: Record<string, unknown> }) =>
          unwrap(ops.can(context, plural, action, target)),
        delete: async (id: number) => {
          await unwrap(ops.remove(context, plural, id))
        },
      }
    },
  })
}
