/**
 * Access-rule evaluation. A rule returns a boolean or a portable FilterNode;
 * the decision carries the FilterNode through untouched — compiling it into a
 * concrete WHERE is the data adapter's job, which keeps this module (and the
 * whole core) ORM-free. Missing rules fall back to the config-level default.
 */
import type {
  AccessAction,
  AccessResult,
  AccessRule,
  FilterCondition,
  FilterNode,
  FilterOperator,
  FilterValue,
  CloudConfigUser,
} from '../index.js'

/** The portable `where()` builder handed to access rules. */
export function makeWhere(): (
  field: string,
  operator: FilterOperator,
  value: FilterValue,
) => FilterCondition {
  return (field, operator, value) => ({ type: 'condition', field, operator, value })
}

export interface AccessDecision {
  allowed: boolean
  /** Present when the rule scoped access to a subset of rows. */
  filter?: FilterNode
  /** True when no rule existed and the config-level default decided. */
  byDefault?: boolean
}

/**
 * Evaluate the access rule for an action. Returns whether it is allowed and,
 * if the rule produced a predicate, the FilterNode for the adapter to AND
 * into the query.
 */
export async function evaluateAccess(
  rule: AccessRule | undefined,
  accessDefault: 'allow' | 'deny',
  ctx: {
    user: unknown
    request: Request
    action: AccessAction
    id?: string | number
    input?: Record<string, unknown>
  },
): Promise<AccessDecision> {
  if (!rule) return { allowed: accessDefault === 'allow', byDefault: true }

  const result: AccessResult = await rule({
    // The identity port is deliberately opaque (`GetUser` may return anything);
    // this is the one boundary where it becomes the rule's `CloudConfigUser` view.
    user: (ctx.user ?? null) as CloudConfigUser | null,
    request: ctx.request,
    action: ctx.action,
    ...(ctx.id !== undefined ? { id: ctx.id } : {}),
    ...(ctx.input !== undefined ? { input: ctx.input } : {}),
    where: makeWhere(),
  })

  if (typeof result === 'boolean') return { allowed: result }

  // A FilterNode result: allow, scoped to matching rows.
  return { allowed: true, filter: result }
}
