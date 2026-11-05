/**
 * PATH that resolves the project's locally-installed CLI binaries
 * (drizzle-kit, wrangler) regardless of how `cloudconfig` itself was launched.
 */
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

const TOOLS = ['drizzle-kit', 'wrangler'] as const

export function withLocalBin(projectDir: string): NodeJS.ProcessEnv {
  const bins = new Set<string>()
  // Walk up: a hoisted or nested install still has to resolve.
  let cur = projectDir
  for (let i = 0; i < 6; i++) {
    bins.add(join(cur, 'node_modules', '.bin'))
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  // Covers pnpm's nested store, where the bin dir is not on any parent path.
  const require = createRequire(join(projectDir, 'noop.js'))
  for (const pkg of TOOLS) {
    try {
      const entry = require.resolve(pkg)
      bins.add(join(entry.slice(0, entry.lastIndexOf('node_modules')), 'node_modules', '.bin'))
    } catch {
      // not installed; skip
    }
  }
  return { ...process.env, PATH: [...bins, process.env['PATH'] ?? ''].join(delimiter) }
}
