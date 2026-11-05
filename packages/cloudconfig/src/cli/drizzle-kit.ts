/**
 * drizzle-kit resolution and install hints for `cloudconfig db generate`.
 *
 * Kept out of `commands/db.ts` so tests can cover messages without shelling
 * out to the binary (and without importing the CLI entrypoint side effects).
 *
 * Detection walks `node_modules/.bin/drizzle-kit` from the project upward (same
 * horizon as `withLocalBin` / wrangler preflight) instead of
 * `createRequire().resolve`, which can pick up unrelated packages via Vitest /
 * tooling module paths.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Resolve the package's actual CLI, without a PATH lookup or a platform shell shim. */
export function findDrizzleKitCli(projectDir: string, maxDepth = 6): string | undefined {
  let cur = resolve(projectDir)
  for (let i = 0; i < maxDepth; i++) {
    const packageDir = join(cur, 'node_modules', 'drizzle-kit')
    const manifestPath = join(packageDir, 'package.json')
    if (existsSync(manifestPath)) {
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        bin?: string | Record<string, string>
      }
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['drizzle-kit']
      if (bin) {
        const path = resolve(packageDir, bin)
        if (existsSync(path)) return path
      }
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * True when a `drizzle-kit` binary is available from the project’s local bins.
 * `probeFn` is injectable for unit tests.
 */
export function isDrizzleKitInstalled(
  projectDir: string,
  probeFn: (dir: string) => boolean = hasLocalDrizzleKitBin,
): boolean {
  return probeFn(projectDir)
}

/** Walk up from `projectDir` looking for `node_modules/.bin/drizzle-kit`. */
export function hasLocalDrizzleKitBin(projectDir: string, maxDepth = 6): boolean {
  let cur = projectDir
  for (let i = 0; i < maxDepth; i++) {
    if (
      ['drizzle-kit', 'drizzle-kit.cmd'].some((name) =>
        existsSync(join(cur, 'node_modules', '.bin', name)),
      )
    ) {
      return true
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
}

/** Developer-facing copy when drizzle-kit is not installed. */
export function missingDrizzleKitMessage(installCommand?: string): string {
  const install =
    installCommand ??
    'pnpm add -D drizzle-kit  # or: npm i -D drizzle-kit / yarn add -D drizzle-kit'
  return [
    'Cannot find package "drizzle-kit" (required for `cloudconfig db generate`).',
    '',
    `  Install: ${install}`,
    '',
    'Then re-run this command.',
  ].join('\n')
}

/** Failure copy when drizzle-kit ran but exited non-zero. */
export function drizzleKitGenerateFailedMessage(error?: unknown): string {
  return [
    'drizzle-kit generate failed. Check the output above for details.',
    error instanceof Error ? error.message : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}
