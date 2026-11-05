/**
 * better-auth resolution. It is an optional peer — a project only installs it
 * once it enables auth — so both `cloudconfig auth` and `cloudconfig doctor` have to be
 * able to say "not installed" without importing it.
 *
 * Walks `node_modules/better-auth` from the project upward, the same horizon as
 * the drizzle-kit and wrangler probes.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function hasBetterAuth(projectDir: string, maxDepth = 6): boolean {
  return hasAuthPackage(projectDir, 'better-auth', maxDepth)
}

export function hasPasskey(projectDir: string): boolean {
  return hasAuthPackage(projectDir, '@better-auth/passkey', 6)
}

function hasAuthPackage(projectDir: string, name: string, maxDepth: number): boolean {
  let cur = projectDir
  for (let i = 0; i < maxDepth; i += 1) {
    if (existsSync(join(cur, 'node_modules', name, 'package.json'))) return true
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
}
