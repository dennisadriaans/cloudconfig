/**
 * The application core: every CRUD operation as a transport-neutral function.
 * Validation, access rules, hooks, timestamps, and persistence orchestration
 * live HERE, expressed against the ports — not against Hono, drizzle, or any
 * status code. `backend.ts` is the REST adapter over this module; a gRPC (or
 * RPC, or queue-consumer) adapter would call these same functions and map
 * `OpResult` codes to its own wire semantics.
 */
import type { AccessAction, AnyConfig, CloudConfigUser, FilterNode, ModelHooks } from '../index.js'
import { evaluateAccess, type AccessDecision } from './access.js'
import {
  compileConfig,
  publicModels,
  type CompiledBase,
  type CompiledModel,
} from './compile/index.js'
import { createStorageLifecycle, storageMapping, type StorageDownload } from './storage.js'
import { publicRow } from './public-row.js'
import { drizzleSqliteProvider } from './adapters/drizzle-sqlite.js'
import { configuredObjectStore } from '../drivers/configured-storage.js'
import type { ObjectStoreProvider } from './object-store.js'
import { autoDetectDriver } from './driver-detect.js'
import type { DbProvider } from './driver.js'
import type {
  AggregateQuery,
  AggregateResult,
  DataAdapter,
  DataProvider,
  GetUser,
  ListQuery,
  PagedResult,
} from './ports.js'
import type { ValidationIssue } from '../shared/errors.js'
import { omitKeys } from '../shared/omit-keys.js'

export type { ValidationIssue } from '../shared/errors.js'

/** Per-call context a transport adapter supplies. */
export interface RequestContext {
  request: Request
  /** A transport-resolved identity. When present, it takes precedence over `getUser`. */
  user?: unknown
  /** Platform bindings (e.g. Cloudflare `env`), when the platform has them. */
  env?: Record<string, unknown>
}

export type OpErrorCode =
  /** No model with that plural name. */
  | 'unknown_model'
  /** The id is not a finite number. */
  | 'invalid_id'
  /** Row absent — or access rules say to pretend it is. */
  | 'not_found'
  /** Access rules deny the action outright. */
  | 'forbidden'
  /** The payload failed field or model validation; `issues` carries details. */
  | 'validation'
  /** The storage layer did not produce a row for a create. */
  | 'write_failed'
  | 'storage_failed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  /** A validated snapshot changed before the write; reload before retrying. */
  | 'conflict'

/** The HTTP status each failure maps to on the server client. */
export const OP_ERROR_STATUS: Record<OpErrorCode, number> = {
  unknown_model: 404,
  invalid_id: 400,
  not_found: 404,
  forbidden: 403,
  validation: 400,
  write_failed: 500,
  storage_failed: 503,
  payload_too_large: 413,
  unsupported_media_type: 415,
  conflict: 409,
}

const OP_ERROR_FALLBACK_MESSAGES: Partial<Record<number, string>> = {
  409: 'This record changed while saving. Reload it and try again.',
  404: 'Record not found.',
  403: 'You cannot perform this action.',
}

/** The message shown for a failed operation when validation gave no specific issue. */
export function getOpErrorFallbackMessage(status: number): string {
  return OP_ERROR_FALLBACK_MESSAGES[status] ?? 'Could not save the record.'
}

export type OpResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: OpErrorCode; issues?: ValidationIssue[]; reason?: OpErrorReason }

/** Why a `forbidden` happened: a rule said no, or there was no rule at all. */
export type OpErrorReason = 'rule_denied' | 'no_rule'

export interface OperationsOptions<TUser = unknown> {
  /**
   * Full custom data stack (any engine, any ORM): implement `DataAdapter` /
   * `DataProvider` and pass it here. Takes precedence over `db`.
   */
  data?: DataProvider
  /** Byte-storage adapter, independent of database and hosting. */
  storage?: ObjectStoreProvider
  /** A connection-level SQLite driver (`cloudconfig/drivers/*`), wrapped in the built-in drizzle adapter. */
  db?: DbProvider
  /** The identity port — resolve the caller from the request. */
  getUser?: GetUser<TUser>
  /** Server authority includes private fields, while access rules still apply. */
  authority?: 'client' | 'server' | 'storage'
}

/** The transport-neutral CRUD surface for a compiled config. */
export interface Operations {
  readonly base: CompiledBase
  list(ctx: RequestContext, modelPlural: string, query: ListQuery): Promise<OpResult<PagedResult>>
  /** Counts or reduces the rows the `list` rule lets this caller see, optionally per group. */
  aggregate(
    ctx: RequestContext,
    modelPlural: string,
    query: AggregateQuery,
  ): Promise<OpResult<AggregateResult>>
  get(
    ctx: RequestContext,
    modelPlural: string,
    id: unknown,
  ): Promise<OpResult<Record<string, unknown>>>
  create(
    ctx: RequestContext,
    modelPlural: string,
    input: unknown,
  ): Promise<OpResult<Record<string, unknown>>>
  update(
    ctx: RequestContext,
    modelPlural: string,
    id: unknown,
    patch: unknown,
  ): Promise<OpResult<Record<string, unknown>>>
  remove(ctx: RequestContext, modelPlural: string, id: unknown): Promise<OpResult<null>>
  /**
   * Would `action` be allowed for this caller? Evaluates the same access rule as the matching
   * operation and, when `id` is given, requires the row to exist within the rule's predicate.
   * Never writes. Use it for previews and reviews; the real operation still enforces access.
   */
  can(
    ctx: RequestContext,
    modelPlural: string,
    action: AccessAction,
    target?: { id?: unknown; input?: Record<string, unknown> },
  ): Promise<OpResult<boolean>>
  upload(
    ctx: RequestContext,
    modelPlural: string,
    input: unknown,
  ): Promise<OpResult<Record<string, unknown>>>
  download(
    ctx: RequestContext,
    modelPlural: string,
    id: unknown,
  ): Promise<OpResult<StorageDownload>>
  retryStorageCleanup(
    ctx: RequestContext,
    modelPlural: string,
  ): Promise<OpResult<{ cleaned: number }>>
}

function fail<T>(code: OpErrorCode, issues?: ValidationIssue[]): OpResult<T> {
  return { ok: false, code, ...(issues ? { issues } : {}) }
}

/** A denial, tagged so transports can tell "no rule" apart from "rule said no". */
function denied<T>(decision: AccessDecision, code: 'forbidden' | 'not_found'): OpResult<T> {
  return { ok: false, code, reason: decision.byDefault ? 'no_rule' : 'rule_denied' }
}

function flattenIssues(err: unknown): ValidationIssue[] {
  if (typeof err === 'object' && err !== null && 'issues' in err && Array.isArray(err.issues)) {
    return err.issues.map((issue: unknown) => {
      if (typeof issue === 'object' && issue !== null && 'message' in issue) {
        const path = 'path' in issue && Array.isArray(issue.path) ? issue.path.join('.') : ''
        return { path, message: String(issue.message) }
      }
      return { path: '', message: 'invalid' }
    })
  }
  return []
}

/** Narrow a parsed zod result (typed `unknown` on the erased schema) to a record. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {}
}

/** Validators see write-shaped fields, including unchanged relation IDs. */
function validationInput(
  model: CompiledModel,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const input = { ...row }
  for (const relation of model.relationships) {
    input[relation.fieldName] = asRecord(row[relation.relationKey])['id'] ?? null
  }
  return omitKeys(
    input,
    model.relationships.map((relation) => relation.relationKey),
  )
}

function privateInputIssues(
  model: CompiledModel,
  body: unknown,
  trusted: boolean,
): ValidationIssue[] {
  if (trusted || !body || typeof body !== 'object') return []
  return Object.values(model.fieldSpecs)
    .filter(({ columnKey, spec }) => spec.serverOnly && columnKey in body)
    .map(({ columnKey }) => ({ path: columnKey, message: 'This field is managed by the server.' }))
}

function privateFilter(model: CompiledModel, node: FilterNode): boolean {
  return node.type === 'condition'
    ? model.fieldSpecs[node.field]?.spec.serverOnly === true
    : node.children.some((child) => privateFilter(model, child))
}

function privateQuery(model: CompiledModel, query: ListQuery): boolean {
  const { sortBy, filters } = query
  return (
    !!(sortBy && model.fieldSpecs[sortBy]?.spec.serverOnly) ||
    !!(filters && privateFilter(model, filters))
  )
}

function isDateColumn(model: CompiledModel, key: string): boolean {
  const kind = model.fieldSpecs[key]?.spec.kind
  return (
    kind === 'date' ||
    kind === 'datetime' ||
    (model.timestamps && (key === 'createdAt' || key === 'updatedAt'))
  )
}

function aggregateIssues(
  model: CompiledModel,
  query: AggregateQuery,
  trusted: boolean,
): ValidationIssue[] {
  const { op, field, groupBy, interval, filters } = query
  const issues: ValidationIssue[] = []
  const readable = (key: string) => {
    const spec = model.fieldSpecs[key]?.spec
    return spec ? trusted || !spec.serverOnly : isDateColumn(model, key)
  }

  if (field === undefined) {
    if (op !== 'count') issues.push({ path: 'field', message: `${op} needs a field.` })
  } else if (!readable(field)) {
    issues.push({ path: 'field', message: 'Aggregate a public field of this model.' })
  } else if (op !== 'count' && !NUMERIC_KINDS.has(model.fieldSpecs[field]?.spec.kind ?? '')) {
    issues.push({ path: 'field', message: `${op} needs a number field.` })
  }

  if (groupBy === undefined) {
    if (interval) issues.push({ path: 'interval', message: 'interval needs a date groupBy.' })
  } else if (!readable(groupBy)) {
    issues.push({ path: 'groupBy', message: 'Group by a public field of this model.' })
  } else if (UNGROUPABLE_KINDS.has(model.fieldSpecs[groupBy]?.spec.kind ?? '')) {
    issues.push({ path: 'groupBy', message: 'This field cannot be grouped.' })
  } else if (interval && !isDateColumn(model, groupBy)) {
    issues.push({ path: 'interval', message: 'interval needs a date groupBy.' })
  }

  if (!trusted && filters && privateFilter(model, filters)) {
    issues.push({ path: 'filters', message: 'Query fields must be public.' })
  }

  return issues
}

const NUMERIC_KINDS: ReadonlySet<string> = new Set(['number', 'float'])
// Each row holds a whole document or list here, so groups would almost never repeat.
const UNGROUPABLE_KINDS: ReadonlySet<string> = new Set(['json', 'multiselect', 'textarea'])

function nowISO(): string {
  return new Date().toISOString()
}

/**
 * Access defaults to deny, so a model with no rules answers nothing. That is a
 * silent 403/404 at runtime; say it once at boot instead. Production stays
 * quiet — the warning is a development affordance, not an operational signal.
 */
function warnFullyDeniedModels(base: CompiledBase): void {
  if (base.accessDefault !== 'deny') return
  if ((globalThis.process?.env?.['NODE_ENV'] ?? 'development') === 'production') return
  const silent = publicModels(base)
    .filter((model) => Object.keys(model.model.options.access ?? {}).length === 0)
    .map((model) => model.name)
  if (silent.length === 0) return
  console.warn(
    `[cloudconfig] access defaults to "deny" and no rules are set for: ${silent.join(', ')}. ` +
      'Every request to these models will be refused. Add `access` to the model, ' +
      "or set `access: { default: 'allow' }` in the config to opt out.",
  )
}

export function createOperations<C extends AnyConfig>(
  config: C,
  opts: OperationsOptions = {},
): Operations {
  const base = compileConfig(config)
  const trusted = opts.authority === 'server' || opts.authority === 'storage'
  const project = (model: CompiledModel, row: Record<string, unknown>) =>
    trusted ? row : publicRow(base, model, row)
  if (opts.authority !== 'storage') warnFullyDeniedModels(base)

  // model plural → compiled model
  const byPlural = new Map<string, CompiledModel>()
  // Internal models (the auth tables) are deliberately absent: an unrouted
  // model answers `unknown_model`, so no access rule can put them on the wire.
  for (const model of publicModels(base)) byPlural.set(model.namePlural, model)

  function providerFor(ctx: RequestContext): DataProvider {
    if (opts.data) return opts.data
    const db = opts.db ?? autoDetectDriver(ctx.env)
    return drizzleSqliteProvider(base, db)
  }

  async function connect(ctx: RequestContext): Promise<DataAdapter> {
    return providerFor(ctx).connect({ env: ctx.env, request: ctx.request })
  }

  async function userFor(ctx: RequestContext): Promise<unknown> {
    if ('user' in ctx) return ctx.user
    return opts.getUser ? await opts.getUser(ctx.request, { env: ctx.env }) : null
  }

  async function guard(
    ctx: RequestContext,
    model: CompiledModel,
    action: AccessAction,
    extra?: { id?: number; input?: Record<string, unknown> },
  ): Promise<{ user: CloudConfigUser | null; decision: AccessDecision }> {
    // `GetUser` is deliberately opaque; rules and hooks see the `CloudConfigUser` view.
    const user = (await userFor(ctx)) as CloudConfigUser | null
    const decision = await evaluateAccess(
      model.model.options.access?.[action],
      base.accessDefault,
      {
        user,
        request: ctx.request,
        action,
        ...(extra?.id !== undefined ? { id: extra.id } : {}),
        ...(extra?.input !== undefined ? { input: extra.input } : {}),
      },
    )
    return { user, decision }
  }

  const hooks = (model: CompiledModel): ModelHooks => model.model.options.hooks ?? {}

  function parseId(raw: unknown): number | undefined {
    const id = Number(raw)
    return Number.isFinite(id) ? id : undefined
  }

  const storage =
    opts.authority === 'storage'
      ? undefined
      : createStorageLifecycle(createOperations(config, { ...opts, authority: 'storage' }), {
          storeFor: opts.storage ?? ((ctx, storage) => configuredObjectStore(config, ctx, storage)),
          userFor,
          findKey: async (ctx, model, key) => {
            const data = await connect(ctx)
            const result = await data.list(model.name, {
              page: 1,
              pageSize: 1,
              sortDir: 'asc',
              filters: {
                type: 'group',
                logic: 'and',
                children: [
                  {
                    type: 'condition',
                    field: storageMapping(model).key,
                    operator: 'eq',
                    value: key,
                  },
                ],
              },
            })
            return result.data[0]
          },
          authorizeUpload: async (ctx, model, input) => {
            const parsed = (model.serverCreate ?? model.create).safeParse(input)
            if (!parsed.success) return fail('validation', flattenIssues(parsed.error))
            const { decision } = await guard(ctx, model, 'create', {
              input: asRecord(parsed.data),
            })
            return decision.allowed ? { ok: true, value: null } : denied(decision, 'forbidden')
          },
          deletionRow: async (ctx, model, rawId) => {
            const id = parseId(rawId)
            if (id === undefined) return fail('invalid_id')
            const { decision } = await guard(ctx, model, 'delete', { id })
            if (!decision.allowed) return denied(decision, 'not_found')
            const row = await (await connect(ctx)).find(model.name, id, decision.filter)
            return row ? { ok: true, value: row } : fail('not_found')
          },
        })

  return {
    base,
    async upload(ctx, modelPlural, input) {
      const model = byPlural.get(modelPlural)
      if (!model?.model.options.storage || !storage) return fail('unknown_model')
      const result = await storage.upload(ctx, model, input)
      return result.ok ? { ok: true, value: project(model, result.value) } : result
    },
    async download(ctx, modelPlural, id) {
      const model = byPlural.get(modelPlural)
      if (!model?.model.options.storage || !storage) return fail('unknown_model')
      return storage.download(ctx, model, id)
    },
    async retryStorageCleanup(ctx, modelPlural) {
      const model = byPlural.get(modelPlural)
      if (!trusted) return fail('forbidden')
      if (!model?.model.options.storage || !storage) return fail('unknown_model')
      return storage.retryCleanup(ctx, model)
    },

    async list(ctx, modelPlural, query) {
      const model = byPlural.get(modelPlural)
      if (!model) return fail('unknown_model')
      if (!trusted && privateQuery(model, query)) {
        return fail('validation', [{ path: 'filters', message: 'Query fields must be public.' }])
      }
      const { decision } = await guard(ctx, model, 'list')
      if (!decision.allowed) return denied(decision, 'forbidden')
      const data = await connect(ctx)
      const result = await data.list(model.name, {
        ...query,
        ...(decision.filter ? { accessFilter: decision.filter } : {}),
      })
      return { ok: true, value: { ...result, data: result.data.map((row) => project(model, row)) } }
    },

    async aggregate(ctx, modelPlural, query) {
      const model = byPlural.get(modelPlural)
      if (!model) return fail('unknown_model')
      const relation = model.relationships.find(({ relationKey }) => relationKey === query.groupBy)
      const grouped = relation ? { ...query, groupBy: relation.fieldName } : query
      const issues = aggregateIssues(model, grouped, trusted)
      if (issues.length) return fail('validation', issues)
      const { decision } = await guard(ctx, model, 'list')
      if (!decision.allowed) return denied(decision, 'forbidden')
      const { groupBy, interval } = grouped
      const data = await connect(ctx)
      const value = await data.aggregate(model.name, {
        ...grouped,
        ...(groupBy && isDateColumn(model, groupBy) ? { interval: interval ?? 'day' } : {}),
        ...(decision.filter ? { accessFilter: decision.filter } : {}),
      })
      return { ok: true, value }
    },

    async get(ctx, modelPlural, rawId) {
      const model = byPlural.get(modelPlural)
      if (!model) return fail('unknown_model')
      const id = parseId(rawId)
      if (id === undefined) return fail('invalid_id')
      const { decision } = await guard(ctx, model, 'read', { id })
      // Denied reads report not-found, never forbidden — existence stays hidden.
      if (!decision.allowed) return denied(decision, 'not_found')
      const data = await connect(ctx)
      const row = await data.find(model.name, id, decision.filter)
      if (!row) return fail('not_found')
      return { ok: true, value: project(model, row) }
    },

    async create(ctx, modelPlural, body) {
      const model = byPlural.get(modelPlural)
      if (!model) return fail('unknown_model')
      if (model.model.options.storage && opts.authority !== 'storage') {
        return fail('validation', [
          { path: 'file', message: 'Use upload() to create a storage record with bytes.' },
        ])
      }
      const rejected = privateInputIssues(model, body, trusted)
      if (rejected.length) return fail('validation', rejected)
      const parsed = (trusted ? (model.serverCreate ?? model.create) : model.create).safeParse(body)
      if (!parsed.success) return fail('validation', flattenIssues(parsed.error))
      const { user, decision } = await guard(ctx, model, 'create', { input: asRecord(parsed.data) })
      if (!decision.allowed) return denied(decision, 'forbidden')
      const data = await connect(ctx)
      let input: Record<string, unknown> = asRecord(parsed.data)
      const modelHooks = hooks(model)
      if (modelHooks.beforeCreate) {
        input =
          (await modelHooks.beforeCreate({ user, request: ctx.request, env: ctx.env }, input)) ??
          input
      }
      if (model.model.options.storage && opts.authority === 'storage') {
        const fields = storageMapping(model)
        const original = asRecord(parsed.data)
        for (const key of [fields.key, fields.owner, fields.size, fields.mimeType]) {
          input[key] = original[key]
        }
      }
      if (model.timestamps) {
        const ts = nowISO()
        input['createdAt'] = ts
        input['updatedAt'] = ts
      }
      const issues = model.model.options.validate?.(input, null) ?? []
      if (issues.length) return fail('validation', issues)
      const row = await data.create(model.name, input)
      if (!row) return fail('write_failed')
      if (modelHooks.afterChange) {
        await modelHooks.afterChange(
          { user, request: ctx.request, env: ctx.env },
          { action: 'create', row, id: Number(row['id']) },
        )
      }
      return { ok: true, value: project(model, row) }
    },

    async update(ctx, modelPlural, rawId, body) {
      const model = byPlural.get(modelPlural)
      if (!model) return fail('unknown_model')
      const id = parseId(rawId)
      if (id === undefined) return fail('invalid_id')
      const rejected = privateInputIssues(model, body, trusted)
      if (model.model.options.storage && opts.authority !== 'storage') {
        const mapping = storageMapping(model)
        for (const key of [
          mapping.key,
          mapping.owner,
          mapping.size,
          mapping.mimeType,
          ...(mapping.text ? [mapping.text] : []),
        ]) {
          if (body && typeof body === 'object' && key in body) {
            rejected.push({ path: key, message: 'This field is managed by storage.' })
          }
        }
      }
      if (rejected.length) return fail('validation', rejected)
      const parsed = (trusted ? (model.serverUpdate ?? model.update) : model.update).safeParse(body)
      if (!parsed.success) return fail('validation', flattenIssues(parsed.error))
      const { user, decision } = await guard(ctx, model, 'update', {
        id,
        input: asRecord(parsed.data),
      })
      // Denied mutations report not-found, never forbidden — existence stays hidden.
      if (!decision.allowed) return denied(decision, 'not_found')
      const data = await connect(ctx)
      const validate = model.model.options.validate
      let existing: Record<string, unknown> | null = null
      if (validate) {
        const row = await data.find(model.name, id, decision.filter)
        if (!row) return fail('not_found')
        existing = validationInput(model, row)
      } else if (!(await data.exists(model.name, id, decision.filter))) return fail('not_found')
      let patch: Record<string, unknown> = asRecord(parsed.data)
      const modelHooks = hooks(model)
      if (modelHooks.beforeUpdate) {
        patch =
          (await modelHooks.beforeUpdate(
            { user, request: ctx.request, env: ctx.env },
            patch,
            id,
          )) ?? patch
      }
      if (model.timestamps) patch['updatedAt'] = nowISO()
      const issues = validate?.({ ...existing, ...patch }, existing) ?? []
      if (issues.length) return fail('validation', issues)
      const row = await data.update(model.name, id, patch, decision.filter, existing ?? undefined)
      if (!row) {
        return fail(
          existing && (await data.exists(model.name, id, decision.filter))
            ? 'conflict'
            : 'not_found',
        )
      }
      if (modelHooks.afterChange) {
        await modelHooks.afterChange(
          { user, request: ctx.request, env: ctx.env },
          { action: 'update', row, id },
        )
      }
      return { ok: true, value: project(model, row) }
    },

    async can(ctx, modelPlural, action, target = {}) {
      const model = byPlural.get(modelPlural)
      if (!model) return fail('unknown_model')
      const id = target.id === undefined ? undefined : parseId(target.id)
      if (target.id !== undefined && id === undefined) return fail('invalid_id')
      const { decision } = await guard(ctx, model, action, {
        ...(id !== undefined ? { id } : {}),
        ...(target.input !== undefined ? { input: target.input } : {}),
      })
      if (!decision.allowed) return { ok: true, value: false }
      if (id === undefined) return { ok: true, value: true }
      const data = await connect(ctx)
      return { ok: true, value: await data.exists(model.name, id, decision.filter) }
    },

    async remove(ctx, modelPlural, rawId) {
      const model = byPlural.get(modelPlural)
      if (!model) return fail('unknown_model')
      if (model.model.options.storage && storage) return storage.remove(ctx, model, rawId)
      const id = parseId(rawId)
      if (id === undefined) return fail('invalid_id')
      const { user, decision } = await guard(ctx, model, 'delete', { id })
      if (!decision.allowed) return denied(decision, 'not_found')
      const data = await connect(ctx)
      const modelHooks = hooks(model)
      if (modelHooks.beforeDelete) {
        await modelHooks.beforeDelete({ user, request: ctx.request, env: ctx.env }, id)
      }
      const ok = await data.delete(model.name, id, decision.filter)
      if (!ok) return fail('not_found')
      if (modelHooks.afterChange) {
        await modelHooks.afterChange(
          { user, request: ctx.request, env: ctx.env },
          { action: 'delete', id },
        )
      }
      return { ok: true, value: null }
    },
  }
}
