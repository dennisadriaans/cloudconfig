/**
 * The caller's role in an organization, read from the `member` table. Used on
 * every request so a removed member loses access immediately, not when their
 * session expires.
 */
import { and, eq, getTableColumns } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { CompiledBase } from '../compile/index.js'
import type { Db } from '../driver.js'

export function membershipLookup(base: CompiledBase) {
  const table = base.models['member']?.table
  return async (db: Db, userId: number, organizationId: number) => {
    if (!table) return null
    const columns = getTableColumns(table) as Record<string, AnySQLiteColumn>
    const rows = (await (db
      .select({ role: columns['role']! })
      .from(table)
      .where(and(eq(columns['organizationId']!, organizationId), eq(columns['userId']!, userId)))
      .limit(1) as unknown as PromiseLike<{ role: string }[]>)) as { role: string }[]
    const role = rows[0]?.role
    return role ? { id: organizationId, role } : null
  }
}
