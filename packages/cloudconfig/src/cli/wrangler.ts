/**
 * wrangler resolution and install hints for `cloudconfig db migrate` (D1 path).
 *
 * Kept out of `commands/db.ts` so tests can cover messages without shelling
 * out to the binary (and without importing the CLI entrypoint side effects).
 *
 * Detection walks `node_modules/.bin/wrangler` from the project upward (same
 * horizon as `withLocalBin`) instead of `createRequire().resolve`, which can
 * pick up unrelated packages via Vitest / tooling module paths.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const WRANGLER_CONFIG_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'] as const

/** The project's wrangler config file, if it has one. */
export function wranglerConfigPath(projectDir: string): string | undefined {
  for (const name of WRANGLER_CONFIG_FILES) {
    const path = join(projectDir, name)
    if (existsSync(path)) return path
  }
  return undefined
}

/** True when the project declares a wrangler config file. */
export function hasWranglerConfig(projectDir: string): boolean {
  return wranglerConfigPath(projectDir) !== undefined
}

/**
 * True when the wrangler config declares a D1 database. An agent project that
 * stores everything in its own Durable Object SQLite has no D1 binding, and
 * running `wrangler d1 migrations apply` against it would just fail — so
 * `cloudconfig db migrate` checks this before shelling out.
 */
export function hasD1Binding(projectDir: string): boolean {
  const path = wranglerConfigPath(projectDir)
  if (!path) return false
  const text = readFileSync(path, 'utf8')
  return /d1_databases/.test(text)
}

/**
 * True when a `wrangler` binary is available from the project’s local bins.
 * `probeFn` is injectable for unit tests.
 */
export function isWranglerInstalled(
  projectDir: string,
  probeFn: (dir: string) => boolean = hasLocalWranglerBin,
): boolean {
  return probeFn(projectDir)
}

/** Walk up from `projectDir` looking for `node_modules/.bin/wrangler`. */
export function hasLocalWranglerBin(projectDir: string, maxDepth = 6): boolean {
  let cur = projectDir
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(cur, 'node_modules', '.bin', 'wrangler'))) return true
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
}

/** Developer-facing copy when wrangler is not installed. */
export function missingWranglerMessage(installCommand?: string): string {
  const install =
    installCommand ?? 'pnpm add -D wrangler  # or: npm i -D wrangler / yarn add -D wrangler'
  return [
    'Cannot find package "wrangler" (required for `cloudconfig db migrate` with a wrangler config).',
    '',
    `  Install: ${install}`,
    '',
    'Or remove wrangler.toml / wrangler.json to apply migrations to local SQLite instead.',
    '',
    'Then re-run this command.',
  ].join('\n')
}

/** Failure copy when wrangler ran but exited non-zero. */
export function wranglerMigrateFailedMessage(): string {
  return 'wrangler d1 migrations apply failed. Check the output above for details.'
}
