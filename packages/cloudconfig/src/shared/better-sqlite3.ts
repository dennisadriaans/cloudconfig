/**
 * Lazy loader for the optional `better-sqlite3` peer. A static import would
 * crash the whole `cloudconfig` CLI (including `init` / `--help`) when the package is
 * not installed — common right after `cloudconfig init` before the install step.
 */
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

const defaultRequire = createRequire(import.meta.url)

export type BetterSqlite3Constructor = typeof BetterSqlite3

/** True when Node failed to resolve `packageName` (not a native-binding crash). */
export function isMissingPackageError(err: unknown, packageName: string): boolean {
  if (!err || typeof err !== 'object') return false
  const error = err as { code?: unknown; message?: unknown }
  const code = error.code
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return false
  const msg = typeof error.message === 'string' ? error.message : String(err)
  return (
    msg.includes(`'${packageName}'`) ||
    msg.includes(`"${packageName}"`) ||
    msg.includes(`node_modules/${packageName}`) ||
    msg.includes(`node_modules\\${packageName}`)
  )
}

/** Developer-facing copy when the optional peer is absent. */
export function missingBetterSqlite3Message(installCommand?: string): string {
  const install =
    installCommand ??
    'pnpm add -D better-sqlite3  # or: npm i -D better-sqlite3 / yarn add -D better-sqlite3'
  return [
    'Cannot find package "better-sqlite3" (required for local SQLite).',
    '',
    `  Install: ${install}`,
    '',
    'Then re-run this command.',
  ].join('\n')
}

/**
 * Require `better-sqlite3`, or throw an actionable install hint.
 * `requireFn` is injectable for tests.
 */
export function requireBetterSqlite3(
  installCommand?: string,
  requireFn: (id: string) => unknown = defaultRequire,
): BetterSqlite3Constructor {
  try {
    return requireFn('better-sqlite3') as BetterSqlite3Constructor
  } catch (err) {
    if (isMissingPackageError(err, 'better-sqlite3')) {
      throw new Error(missingBetterSqlite3Message(installCommand), { cause: err })
    }
    throw err
  }
}
