import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Allow the scaffold's native tooling on pnpm 10.26+, without replacing existing policy. */
export function ensurePnpmBuilds(projectDir: string): 'written' | 'skipped' {
  let dir = projectDir
  for (;;) {
    // A nested workspace would disconnect the app from its existing monorepo.
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return 'skipped'
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { pnpm?: unknown }
      if (pkg.pnpm !== undefined) return 'skipped'
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    'allowBuilds:\n  better-sqlite3: true\n  esbuild: true\n  sharp: true\n  vue-demi: true\n  workerd: true\n',
  )
  return 'written'
}
