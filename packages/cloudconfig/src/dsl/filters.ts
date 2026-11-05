import type { ValidationIssue } from '../shared/errors.js'
import type { ModelStorage } from './storage.js'

/** A portable filter condition an access rule can build without importing drizzle. */
export interface FilterCondition {
  type: 'condition'
  field: string
  operator: FilterOperator
  value: FilterValue
}

export interface FilterGroup {
  type: 'group'
  logic: 'and' | 'or'
  children: FilterNode[]
}

export type FilterNode = FilterCondition | FilterGroup

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'is_any_of'
  | 'is_none_of'
  | 'like'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'is_empty'
  | 'is_not_empty'

export type FilterValue = string | number | boolean | null | Array<string | number>

/**
 * Builds a portable `FilterCondition`. Access rules use this so a config file
 * never has to import drizzle to express a row-level predicate.
 */
export type WhereBuilder = (
  field: string,
  operator: FilterOperator,
  value: FilterValue,
) => FilterCondition

export type AccessAction = 'list' | 'read' | 'create' | 'update' | 'delete'

/**
 * The default view of a caller inside an access rule or hook.
 *
 * `id` is always a number — CloudConfig ids are integers everywhere, including the
 * `users` table auth owns — so ownership rules like
 * `where('authorId', 'eq', user.id)` typecheck out of the box. Anything else an
 * identity source carries is `unknown` until you name it: parameterize the
 * model (`model<MyUser>(...)` via `ModelOptions<MyUser>`) for a precise shape.
 */
export interface CloudConfigUser {
  id: number
  /**
   * The organization the session is acting in, with the caller's role there.
   * Present when `auth.organizations` is on; `null` when no organization is
   * active or the caller is no longer a member of it.
   */
  organization?: CloudConfigOrganization | null
  [key: string]: unknown
}

/** The active organization as access rules see it — membership already verified. */
export interface CloudConfigOrganization {
  id: number
  /** Better Auth role string; several roles are comma-separated. */
  role: string
}

export interface AccessCtx<TUser = CloudConfigUser> {
  user: TUser | null
  request: Request
  action: AccessAction
  id?: string | number
  input?: Record<string, unknown>
  where: WhereBuilder
}

/**
 * The result of an access rule.
 * - `boolean` — allow/deny outright.
 * - `FilterNode` — allow, scoped to rows matching this predicate.
 *
 * (The FilterNode stays portable all the way to the data adapter, which
 * compiles it for its own engine — so rules work identically on any adapter.)
 */
export type AccessResult = boolean | FilterNode

export type AccessRule<TUser = CloudConfigUser> = (
  ctx: AccessCtx<TUser>,
) => AccessResult | Promise<AccessResult>

export interface AccessRules<TUser = CloudConfigUser> {
  list?: AccessRule<TUser>
  read?: AccessRule<TUser>
  create?: AccessRule<TUser>
  update?: AccessRule<TUser>
  delete?: AccessRule<TUser>
}

export interface HookCtx<TUser = CloudConfigUser> {
  user: TUser | null
  request: Request
  /** Runtime bindings, available to hooks on REST, MCP and server client writes. */
  env?: Record<string, unknown> | undefined
}

export interface ChangeEvent {
  action: 'create' | 'update' | 'delete'
  row?: Record<string, unknown>
  id: string | number
}

export interface ModelHooks<TUser = CloudConfigUser> {
  beforeCreate?: (
    ctx: HookCtx<TUser>,
    input: Record<string, unknown>,
  ) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>
  beforeUpdate?: (
    ctx: HookCtx<TUser>,
    input: Record<string, unknown>,
    id: string | number,
  ) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>
  beforeDelete?: (ctx: HookCtx<TUser>, id: string | number) => void | Promise<void>
  afterChange?: (ctx: HookCtx<TUser>, event: ChangeEvent) => void | Promise<void>
}

export interface ModelOptions<TUser = CloudConfigUser> {
  label?: string
  /** Auto-manage `createdAt`/`updatedAt`. Default true. */
  timestamps?: boolean
  access?: AccessRules<TUser>
  hooks?: ModelHooks<TUser>
  /** Return field issues instead of throwing. Runs after before-write hooks, before persistence. */
  validate?: ModelValidator
  storage?: ModelStorage
}

/** Input is merged on update; relations use `<field>Id`, as in create/update payloads. */
export type ModelValidator = (
  input: Readonly<Record<string, unknown>>,
  existing: Readonly<Record<string, unknown>> | null,
) => ValidationIssue[]
