/**
 * Per-request driver auto-detection. If the platform env exposes a D1 binding
 * (duck-typed the way DashboardStack's generated apps check), lazily load the
 * drizzle D1 driver. Otherwise fail with an actionable message pointing at the
 * explicit-driver option.
 */
import type { Db, DbProvider } from './driver.js'

function looksLikeD1(binding: unknown): boolean {
  return (
    typeof binding === 'object' &&
    binding !== null &&
    'prepare' in binding &&
    'batch' in binding &&
    'dump' in binding
  )
}

export function autoDetectDriver(env: Record<string, unknown> | undefined): DbProvider {
  const dbBinding = env?.['DB']
  if (looksLikeD1(dbBinding)) {
    return {
      id: 'd1-auto',
      async connect(): Promise<Db> {
        const { drizzle } = await import('drizzle-orm/d1')
        return drizzle(dbBinding)
      },
    }
  }
  throw new Error(
    'No database configured. For local Node pass createBackend(config, { db: sqliteFile(".cloudconfig/dev.db") }); for Cloudflare D1 pass { db: d1("DB") } or forward the Workers env so the DB binding can be auto-detected — see cloudconfig/drivers/*.',
  )
}
