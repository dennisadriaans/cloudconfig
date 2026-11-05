/**
 * Guard: the cloudconfig package must build on install so workspace consumers get a
 * working `cloudconfig` bin. Without `prepare`, `dist/` is missing after a cold
 * `pnpm install` (it is gitignored) and example scripts fail with
 * "Command cloudconfig not found".
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')

describe('cloudconfig package prepare script', () => {
  it('runs build on prepare so dist/cli exists after pnpm install', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      bin?: Record<string, string>
      scripts?: Record<string, string>
    }
    expect(pkg.bin?.cloudconfig).toBe('./dist/cli/index.js')
    expect(pkg.scripts?.prepare).toMatch(/^(pnpm run )?build$|^tsdown$/)
    expect(pkg.scripts?.build).toBeTruthy()
  })
})
