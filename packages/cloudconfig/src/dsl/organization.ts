/**
 * Organization-aware access helpers. Pure functions over the rule context, so
 * a config file can share rows inside an organization without importing
 * anything server-side.
 *
 * The organization on `user` is resolved from the session and the `member`
 * table on every request: a removed member loses access on their next request,
 * not when their session expires.
 */
import type { AccessResult, CloudConfigUser, WhereBuilder } from './filters.js'

/** Whether the caller holds one of `roles` in the active organization. */
export function hasOrgRole(
  user: Pick<CloudConfigUser, 'organization'> | null | undefined,
  ...roles: string[]
): boolean {
  const role = user?.organization?.role
  if (!role) return false
  return role.split(',').some((entry) => roles.includes(entry.trim()))
}

/**
 * Rows of the caller's active organization. Denies callers without one, so a
 * rule written with it can never fall through to "every organization".
 */
export function orgRows(
  user: Pick<CloudConfigUser, 'organization'> | null | undefined,
  where: WhereBuilder,
  field = 'organizationId',
): AccessResult {
  const id = user?.organization?.id
  return typeof id === 'number' ? where(field, 'eq', id) : false
}

/**
 * Rows the caller owns inside the active organization — the shape for
 * personal records that still belong to one workspace.
 */
export function ownOrgRows(
  user: (Pick<CloudConfigUser, 'organization'> & { id: number }) | null | undefined,
  where: WhereBuilder,
  fields: { owner?: string; organization?: string } = {},
): AccessResult {
  const organization = user?.organization?.id
  if (!user || typeof organization !== 'number') return false
  return {
    type: 'group',
    logic: 'and',
    children: [
      where(fields.owner ?? 'ownerId', 'eq', user.id),
      where(fields.organization ?? 'organizationId', 'eq', organization),
    ],
  }
}
