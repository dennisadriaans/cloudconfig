/**
 * Covers `cloudconfig doctor` readiness checks: config, mount, deps, migrations, wrangler.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasLocalBetterSqlite3, runDoctor } from '../src/cli/doctor.js'
import type { AnyConfig } from '../src/index.js'
import { missingBetterSqlite3Message } from '../src/shared/better-sqlite3.js'
import { LOCAL_DB_PATH } from '../src/shared/local-db.js'
import {
  NO_MIGRATIONS_HINT,
  applyLocalMigrations,
  listPendingLocalMigrations,
} from '../src/cli/migrate-local.js'
import { NEXT_EXTERNAL_HINT } from '../src/cli/framework-externals.js'

const EMPTY_CONFIG = { models: {} } as AnyConfig

const CONFIG = `import { defineBackend, model, t } from '@cloudconfig/core'

export const config = defineBackend({
  models: {
    item: model({ name: t.text().required() }),
  },
})
`

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'cloudconfig-doctor-'))
}

function writeConfig(dir: string): void {
  writeFileSync(join(dir, 'cloud.config.ts'), CONFIG)
}

function writeNuxtModuleConfig(dir: string): void {
  writeFileSync(
    join(dir, 'nuxt.config.ts'),
    `export default defineNuxtConfig({\n  modules: ['@cloudconfig/nuxt'],\n})\n`,
  )
}

function writeNuxtMount(dir: string, body?: string): void {
  mkdirSync(join(dir, 'server', 'api'), { recursive: true })
  writeFileSync(
    join(dir, 'server', 'api', '[...].ts'),
    body ??
      `import { createBackend } from '@cloudconfig/core/server'
import { sqliteFile } from '@cloudconfig/core/drivers/better-sqlite3'
import { config } from '~~/cloud.config'
const app = createBackend(config, { db: sqliteFile('.cloudconfig/dev.db') })
export default defineEventHandler((event) => app.fetch(event.node.req as never))
`,
  )
}

function writeMigration(dir: string): void {
  mkdirSync(join(dir, 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'migrations', '0000_init.sql'), 'SELECT 1;')
}

describe('hasLocalBetterSqlite3', () => {
  it('finds better-sqlite3 via node_modules walk', () => {
    const dir = tempProject()
    try {
      expect(hasLocalBetterSqlite3(dir)).toBe(false)
      mkdirSync(join(dir, 'node_modules', 'better-sqlite3'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'better-sqlite3', 'package.json'), '{}')
      expect(hasLocalBetterSqlite3(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runDoctor', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function project(): string {
    const dir = tempProject()
    dirs.push(dir)
    return dir
  }

  const probesOk = {
    isDrizzleKitInstalled: () => true,
    isWranglerInstalled: () => true,
    hasBetterSqlite3: () => true,
  }

  it('fails when no config exists', async () => {
    const dir = project()
    const report = await runDoctor(dir, probesOk)
    expect(report.ok).toBe(false)
    const config = report.checks.find((c) => c.id === 'config')
    expect(config?.status).toBe('fail')
    expect(config?.detail).toMatch(/cloudconfig init/)
  })

  it('passes a ready standalone project', async () => {
    const dir = project()
    writeConfig(dir)
    writeMigration(dir)
    applyLocalMigrations(join(dir, LOCAL_DB_PATH), join(dir, 'migrations'))
    // loadConfig needs resolvable `cloudconfig` — unit tests inject loadConfig
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.framework).toBe('standalone')
    expect(report.ok).toBe(true)
    expect(report.checks.every((c) => c.status === 'ok')).toBe(true)
    const migrations = report.checks.find((c) => c.id === 'migrations')
    expect(migrations?.detail).toMatch(/applied/)
  })

  it('warns when local migrations are pending', async () => {
    const dir = project()
    writeConfig(dir)
    writeMigration(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(true)
    const migrations = report.checks.find((c) => c.id === 'migrations')
    expect(migrations?.status).toBe('warn')
    expect(migrations?.detail).toMatch(/pending locally: 0000_init\.sql/)
    expect(migrations?.detail).toMatch(/cloudconfig db migrate/)
  })

  it('oks migrations after the local ledger is caught up', async () => {
    const dir = project()
    writeConfig(dir)
    writeMigration(dir)
    applyLocalMigrations(join(dir, LOCAL_DB_PATH), join(dir, 'migrations'))
    expect(listPendingLocalMigrations(join(dir, LOCAL_DB_PATH), ['0000_init.sql'])).toEqual([])
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    const migrations = report.checks.find((c) => c.id === 'migrations')
    expect(migrations?.status).toBe('ok')
    expect(migrations?.detail).toMatch(/1 SQL file\(s\) applied/)
  })

  it('skips local ledger inspection when better-sqlite3 is missing', async () => {
    const dir = project()
    writeConfig(dir)
    writeMigration(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      hasBetterSqlite3: () => false,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(false)
    const migrations = report.checks.find((c) => c.id === 'migrations')
    expect(migrations?.status).toBe('ok')
    expect(migrations?.detail).toBe('1 SQL file(s) in migrations/')
  })

  it('fails when migrations are missing', async () => {
    const dir = project()
    writeConfig(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(false)
    const migrations = report.checks.find((c) => c.id === 'migrations')
    expect(migrations?.status).toBe('fail')
    expect(migrations?.detail).toBe(NO_MIGRATIONS_HINT)
  })

  it('fails when drizzle-kit is missing', async () => {
    const dir = project()
    writeConfig(dir)
    writeMigration(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    const report = await runDoctor(dir, {
      ...probesOk,
      isDrizzleKitInstalled: () => false,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(false)
    const kit = report.checks.find((c) => c.id === 'drizzle-kit')
    expect(kit?.status).toBe('fail')
    expect(kit?.detail).toMatch(/drizzle-kit/)
    expect(kit?.detail).toMatch(/npm install -D drizzle-kit/)
  })

  it('fails when better-sqlite3 is missing for local frameworks', async () => {
    const dir = project()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { nuxt: '^3' } }))
    writeConfig(dir)
    writeNuxtModuleConfig(dir)
    writeMigration(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      hasBetterSqlite3: () => false,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(false)
    const sqlite = report.checks.find((c) => c.id === 'better-sqlite3')
    expect(sqlite?.status).toBe('fail')
    expect(sqlite?.detail).toBe(missingBetterSqlite3Message('npm install -D better-sqlite3'))
  })

  it('fails when the framework mount file is missing', async () => {
    const dir = project()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '^15' } }))
    writeConfig(dir)
    writeMigration(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(false)
    const mount = report.checks.find((c) => c.id === 'mount')
    expect(mount?.status).toBe('fail')
    expect(mount?.detail).toMatch(/Missing app\/api/)
    expect(mount?.detail).toMatch(/cloudconfig init/)
  })

  it('warns when the mount has createBackend but no db driver', async () => {
    const dir = project()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '^15' } }))
    writeConfig(dir)
    mkdirSync(join(dir, 'app', 'api', '[[...cloudconfig]]'), { recursive: true })
    writeFileSync(
      join(dir, 'app', 'api', '[[...cloudconfig]]', 'route.ts'),
      `import { createBackend } from '@cloudconfig/core/server'
import { config } from '@/cloud.config'
const app = createBackend(config)
export const GET = (req: Request) => app.fetch(req)
`,
    )
    writeMigration(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(true)
    const mount = report.checks.find((c) => c.id === 'mount')
    expect(mount?.status).toBe('warn')
    expect(mount?.detail).toMatch(/sqliteFile|d1/)
  })

  it('fails when wrangler config is present but wrangler is not installed', async () => {
    const dir = project()
    writeConfig(dir)
    writeMigration(dir)
    writeFileSync(join(dir, 'wrangler.toml'), 'name = "app"\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    const report = await runDoctor(dir, {
      ...probesOk,
      isWranglerInstalled: () => false,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(false)
    const wrangler = report.checks.find((c) => c.id === 'wrangler')
    expect(wrangler?.status).toBe('fail')
    expect(wrangler?.detail).toMatch(/wrangler/)
  })

  it('warns when Next config is missing better-sqlite3 externals', async () => {
    const dir = project()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '^15' } }))
    writeConfig(dir)
    mkdirSync(join(dir, 'app', 'api', '[[...cloudconfig]]'), { recursive: true })
    writeFileSync(
      join(dir, 'app', 'api', '[[...cloudconfig]]', 'route.ts'),
      `import { createBackend } from '@cloudconfig/core/server'
import { sqliteFile } from '@cloudconfig/core/drivers/better-sqlite3'
import { config } from '../../../cloud.config'
export const GET = createBackend(config, { db: sqliteFile('.cloudconfig/dev.db') }).fetch
`,
    )
    writeFileSync(join(dir, 'next.config.js'), `module.exports = { reactStrictMode: true }\n`)
    writeMigration(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(true)
    const externals = report.checks.find((c) => c.id === 'externals')
    expect(externals?.status).toBe('warn')
    expect(externals?.detail).toContain('next.config.js')
    expect(externals?.detail).toContain(NEXT_EXTERNAL_HINT)
  })

  it('oks externals when the Nuxt module is registered — it sets them itself', async () => {
    const dir = project()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { nuxt: '^3' } }))
    writeConfig(dir)
    writeNuxtModuleConfig(dir)
    writeMigration(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(true)
    const mount = report.checks.find((c) => c.id === 'mount')
    expect(mount?.status).toBe('ok')
    const externals = report.checks.find((c) => c.id === 'externals')
    expect(externals?.status).toBe('ok')
    expect(externals?.detail).toContain('@cloudconfig/nuxt')
  })

  it('fails when the Nuxt config does not register the module', async () => {
    const dir = project()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { nuxt: '^3' } }))
    writeConfig(dir)
    writeFileSync(join(dir, 'nuxt.config.ts'), `export default defineNuxtConfig({})\n`)
    writeMigration(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    expect(report.ok).toBe(false)
    const mount = report.checks.find((c) => c.id === 'mount')
    expect(mount?.status).toBe('fail')
    expect(mount?.detail).toContain('@cloudconfig/nuxt')
  })

  it('warns when a pre-module catch-all route is still present', async () => {
    const dir = project()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { nuxt: '^3' } }))
    writeConfig(dir)
    writeNuxtModuleConfig(dir)
    writeNuxtMount(dir)
    writeMigration(dir)
    const report = await runDoctor(dir, {
      ...probesOk,
      loadConfig: async () => ({ path: join(dir, 'cloud.config.ts'), config: EMPTY_CONFIG }),
    })
    const legacy = report.checks.find((c) => c.label === 'Legacy mount')
    expect(legacy?.status).toBe('warn')
    expect(legacy?.detail).toContain('server/api/[...].ts')
  })
})
