/**
 * Resolve the MCP server key for a project from its `package.json` `name`.
 *
 * The key becomes part of the tool identifiers a host exposes to the model
 * (e.g. `mcp__my-app__agents_list`), and most hosts only accept
 * `[A-Za-z0-9_-]` there. npm names are far more permissive — scopes (`@acme/`),
 * dots, and other punctuation are all legal — so the raw name is sanitized
 * rather than passed through: the scope is dropped and anything outside the
 * safe charset collapses to `-`.
 *
 * Dropping the scope keeps the key readable and still collision-free for the
 * common case (one app per directory); two same-named packages under different
 * scopes in one workspace would need a manual rename.
 *
 * The key names the *user's* project, never the framework: when `package.json`
 * is missing, unreadable, or nameless we fall back to the project directory
 * name, and only to `"cloudconfig"` when even that sanitizes to nothing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export const DEFAULT_MCP_NAME = 'cloudconfig'

/** Coerce an arbitrary package name into a host-safe MCP server key. */
export function sanitizeMcpName(raw: string): string {
  const unscoped = raw.trim().replace(/^@[^/]+\//, '')
  const safe = unscoped
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return safe || DEFAULT_MCP_NAME
}

/** Last resort before `"cloudconfig"`: the project directory's own name. */
function directoryNameFor(projectDir: string): string {
  const dir = basename(resolve(projectDir))
  return dir ? sanitizeMcpName(dir) : DEFAULT_MCP_NAME
}

export function packageNameFor(projectDir: string): string {
  const pkgPath = join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) return directoryNameFor(projectDir)
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown }
    if (typeof pkg.name === 'string' && pkg.name.trim()) return sanitizeMcpName(pkg.name)
  } catch {
    // ignore malformed package.json
  }
  return directoryNameFor(projectDir)
}
