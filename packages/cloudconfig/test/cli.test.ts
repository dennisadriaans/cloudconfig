import { execFileSync } from 'node:child_process'
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { detectFramework } from '../src/cli/detect.js'
import { dbGenerate, dbMigrate } from '../src/cli/commands/db.js'
import { STARTER_CONFIG } from '../src/cli/scaffold.js'
import { CONFIG_FILENAMES } from '../src/shared/config-module.js'
import { applyLocalMigrations, listPendingLocalMigrations } from '../src/cli/migrate-local.js'
import { writeShim } from '../src/cli/shim.js'
import { createBackend } from '../src/server/backend.js'
import type { Db, DbProvider } from '../src/server/driver.js'

const cloudconfigPackageRoot = join(import.meta.dirname, '..')

/** Temp projects need a resolvable `cloudconfig` package for the generated shim schema. */
function linkCloudConfigPackage(projectDir: string): void {
  const linkPath = join(projectDir, 'node_modules', '@cloudconfig', 'core')
  mkdirSync(join(projectDir, 'node_modules', '@cloudconfig'), { recursive: true })
  if (!existsSync(linkPath)) {
    symlinkSync(cloudconfigPackageRoot, linkPath, 'dir')
  }
  symlinkSync(
    join(cloudconfigPackageRoot, 'node_modules', 'drizzle-kit'),
    join(projectDir, 'node_modules', 'drizzle-kit'),
    'dir',
  )
  symlinkSync(
    join(cloudconfigPackageRoot, 'node_modules', '.bin'),
    join(projectDir, 'node_modules', '.bin'),
    'dir',
  )
}

function drizzleKitGenerate(projectDir: string, drizzleConfigPath: string): void {
  const bin = join(cloudconfigPackageRoot, 'node_modules', '.bin', 'drizzle-kit')
  execFileSync(bin, ['generate', '--config', drizzleConfigPath], {
    cwd: projectDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      PATH: `${join(cloudconfigPackageRoot, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
    },
  })
}

const config = defineBackend({
  access: { default: 'allow' },
  models: {
    user: model({ name: t.text().required(), email: t.email().required().unique() }),
    post: model({ title: t.text().required(), author: t.relation('user') }),
  },
})

describe('fresh-project database commands', () => {
  for (const filename of CONFIG_FILENAMES) {
    it.each(['named', 'default'])(
      'generates and migrates %s exports from ' + filename,
      async (style) => {
        const projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-db-contract-'))
        const originalExitCode = process.exitCode
        try {
          process.exitCode = undefined
          linkCloudConfigPackage(projectDir)
          writeFileSync(
            join(projectDir, 'package.json'),
            JSON.stringify({ dependencies: { nuxt: '^4' } }),
          )
          writeFileSync(
            join(projectDir, filename),
            style === 'named'
              ? STARTER_CONFIG
              : STARTER_CONFIG.replace('export const config =', 'export default'),
          )
          await dbGenerate(projectDir)
          expect(process.exitCode).toBeUndefined()
          expect(
            readdirSync(join(projectDir, 'migrations')).filter((name) => name.endsWith('.sql')),
          ).toHaveLength(1)
          await dbMigrate(projectDir, false)
          const db = new Database(join(projectDir, '.cloudconfig', 'dev.db'))
          try {
            const tables = db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
              .all() as { name: string }[]
            expect(tables.map((table) => table.name)).toEqual(
              expect.arrayContaining(['posts', 'users', 'accounts', 'sessions', 'verifications']),
            )
            expect(
              db.prepare('SELECT COUNT(*) AS count FROM _cloudconfig_migrations').get(),
            ).toEqual({ count: 1 })
          } finally {
            db.close()
          }
          await dbGenerate(projectDir)
          await dbMigrate(projectDir, false)
          expect(process.exitCode).toBeUndefined()
          expect(
            readdirSync(join(projectDir, 'migrations')).filter((name) => name.endsWith('.sql')),
          ).toHaveLength(1)
        } finally {
          process.exitCode = originalExitCode
          rmSync(projectDir, { recursive: true, force: true })
        }
      },
      30_000,
    )
  }

  it.skipIf(process.platform === 'win32')(
    'uses the running Node instead of a different node on PATH',
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-db-node-'))
      const originalPath = process.env['PATH']
      const originalExitCode = process.exitCode
      try {
        process.exitCode = undefined
        linkCloudConfigPackage(projectDir)
        writeFileSync(join(projectDir, 'cloud.config.ts'), STARTER_CONFIG)
        const binDir = join(projectDir, 'old-node-bin')
        mkdirSync(binDir)
        const node = join(binDir, 'node')
        writeFileSync(node, '#!/bin/sh\nexit 42\n')
        chmodSync(node, 0o755)
        process.env['PATH'] = `${binDir}:${originalPath ?? ''}`
        await dbGenerate(projectDir)
        expect(process.exitCode).toBeUndefined()
        expect(
          readdirSync(join(projectDir, 'migrations')).some((name) => name.endsWith('.sql')),
        ).toBe(true)
      } finally {
        if (originalPath === undefined) delete process.env['PATH']
        else process.env['PATH'] = originalPath
        process.exitCode = originalExitCode
        rmSync(projectDir, { recursive: true, force: true })
      }
    },
    30_000,
  )
})

describe('detectFramework', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloudconfig-detect-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('returns standalone for a bare directory', () => {
    expect(detectFramework(dir)).toBe('standalone')
  })

  it('detects nuxt from dependencies', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { nuxt: '^4' } }))
    expect(detectFramework(dir)).toBe('nuxt')
  })
})

describe('dbMigrate framework local-sqlite fallback', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloudconfig-fw-migrate-'))
    linkCloudConfigPackage(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { nuxt: '^3' } }))
    writeFileSync(
      join(dir, 'cloud.config.ts'),
      `import { defineBackend, model, t } from '@cloudconfig/core'

export const config = defineBackend({
  models: {
    item: model({ name: t.text().required() }),
  },
})`,
    )
    mkdirSync(join(dir, 'migrations'))
    writeFileSync(
      join(dir, 'migrations', '0000_init.sql'),
      `CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    )
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('applies to local SQLite when wrangler.toml is absent', async () => {
    expect(detectFramework(dir)).toBe('nuxt')
    await dbMigrate(dir, false)
    expect(existsSync(join(dir, '.cloudconfig', 'dev.db'))).toBe(true)
  })

  it('keeps Nuxt migrations on the local SQLite file when a deploy config exists', async () => {
    writeFileSync(join(dir, 'wrangler.jsonc'), '{"name":"nuxt-app"}')
    await dbMigrate(dir, false)
    const sqlite = new Database(join(dir, '.cloudconfig', 'dev.db'))
    try {
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'items'").get()).toEqual({
        name: 'items',
      })
    } finally {
      sqlite.close()
    }
  })
})

describe('dbMigrate with wrangler config but no wrangler package', () => {
  let dir: string
  const originalExitCode = process.exitCode

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloudconfig-migrate-no-wrangler-'))
    linkCloudConfigPackage(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '^15' } }))
    writeFileSync(join(dir, 'wrangler.toml'), 'name = "app"\n')
    writeFileSync(
      join(dir, 'cloud.config.ts'),
      `import { defineBackend, model, t } from '@cloudconfig/core'

export const config = defineBackend({
  models: {
    item: model({ name: t.text().required() }),
  },
})`,
    )
    mkdirSync(join(dir, 'migrations'))
    writeFileSync(
      join(dir, 'migrations', '0000_init.sql'),
      `CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    )
  })
  afterAll(() => {
    process.exitCode = originalExitCode
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints a package-manager install hint instead of shelling out', async () => {
    process.exitCode = undefined
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    try {
      await dbMigrate(dir, false)
      expect(process.exitCode).toBe(1)
      expect(errors.some((line) => line.includes('Cannot find package "wrangler"'))).toBe(true)
      expect(errors.some((line) => /pnpm add -D wrangler|npm install -D wrangler/.test(line))).toBe(
        true,
      )
      expect(existsSync(join(dir, '.cloudconfig', 'dev.db'))).toBe(false)
    } finally {
      spy.mockRestore()
      process.exitCode = undefined
    }
  })
})

describe('dbMigrate with no generated migrations', () => {
  let dir: string
  const originalExitCode = process.exitCode

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloudconfig-migrate-empty-'))
    linkCloudConfigPackage(dir)
    writeFileSync(
      join(dir, 'cloud.config.ts'),
      `import { defineBackend, model, t } from '@cloudconfig/core'

export const config = defineBackend({
  models: {
    item: model({ name: t.text().required() }),
  },
})`,
    )
  })
  afterAll(() => {
    process.exitCode = originalExitCode
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails with a generate hint instead of claiming "no pending"', async () => {
    process.exitCode = undefined
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    try {
      await dbMigrate(dir, false)
      expect(process.exitCode).toBe(1)
      expect(logs.some((line) => line.includes('No migrations generated yet'))).toBe(true)
      expect(logs.some((line) => line.includes('cloudconfig db generate'))).toBe(true)
      expect(logs.some((line) => line.includes('No pending migrations'))).toBe(false)
    } finally {
      spy.mockRestore()
      process.exitCode = undefined
    }
  })
})

describe('writeShim', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloudconfig-shim-'))
    writeFileSync(join(dir, 'cloud.config.ts'), 'export const config = {}')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('emits a schema module re-exporting each table', () => {
    const paths = writeShim(dir, join(dir, 'cloud.config.ts'), config, 'migrations')
    expect(existsSync(paths.schemaPath)).toBe(true)
    expect(existsSync(paths.drizzleConfigPath)).toBe(true)
    const schema = readdirSync(paths.dir)
    expect(schema).toContain('schema.ts')
    expect(schema).toContain('drizzle.config.ts')
    const drizzleConfig = readFileSync(paths.drizzleConfigPath, 'utf8')
    expect(drizzleConfig).toContain('schema: "./.cloudconfig/schema.ts"')
    expect(drizzleConfig).toContain('out: "./migrations"')
  })

  it('exports the SCIM and Connect tables so migrations create them', () => {
    const withConnect = defineBackend({
      auth: { emailPassword: true, organizations: true, scim: true },
      connect: { providers: { github: true }, mcp: true },
      models: { note: model({ title: t.text() }) },
    })
    const paths = writeShim(dir, join(dir, 'cloud.config.ts'), withConnect, 'migrations')
    const schema = readFileSync(paths.schemaPath, 'utf8')
    for (const name of ['scimToken', 'scimIdentity', 'connectConnection', 'connectClient']) {
      expect(schema).toContain(`export const ${name} = tables['${name}']`)
    }
  })
})

describe('applyLocalMigrations', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloudconfig-migrate-'))
    mkdirSync(join(dir, 'migrations'))
    writeFileSync(
      join(dir, 'migrations', '0000_init.sql'),
      `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, author_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    )
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('applies pending migrations and is idempotent', () => {
    const dbPath = join(dir, '.cloudconfig', 'dev.db')
    const migrationsDir = join(dir, 'migrations')

    const first = applyLocalMigrations(dbPath, migrationsDir)
    expect(first.applied).toEqual(['0000_init.sql'])
    expect(first.onDisk).toBe(1)

    const second = applyLocalMigrations(dbPath, migrationsDir)
    expect(second.applied).toEqual([])
    expect(second.alreadyApplied).toBe(1)
    expect(second.onDisk).toBe(1)
  })

  it('reports onDisk zero when no SQL migrations exist yet', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cloudconfig-migrate-nodisk-'))
    try {
      const result = applyLocalMigrations(join(empty, 'dev.db'), join(empty, 'migrations'))
      expect(result.onDisk).toBe(0)
      expect(result.applied).toEqual([])
      expect(result.alreadyApplied).toBe(0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('serves CRUD through createBackend against the migrated db', async () => {
    const dbPath = join(dir, '.cloudconfig', 'dev.db')
    const sqlite = new Database(dbPath)
    const db: Db = drizzle(sqlite)
    const provider: DbProvider = { id: 'test', connect: (): Db => db }
    const app = createBackend(config, { db: provider })

    const res = await app.request('http://localhost/api/users', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada', email: 'ada@x.com' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.name).toBe('Ada')
    sqlite.close()
  })

  it('rejects a tampered already-applied migration', () => {
    const dbPath = join(dir, '.cloudconfig', 'dev.db')
    writeFileSync(join(dir, 'migrations', '0000_init.sql'), 'CREATE TABLE changed (id INTEGER);')
    expect(() => applyLocalMigrations(dbPath, join(dir, 'migrations'))).toThrow(/contents changed/)
  })
})

describe('listPendingLocalMigrations', () => {
  it('treats all files as pending when the database is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-pending-'))
    try {
      expect(listPendingLocalMigrations(join(dir, 'missing.db'), ['0000_init.sql'])).toEqual([
        '0000_init.sql',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns only unapplied files after migrate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-pending-'))
    try {
      const migrationsDir = join(dir, 'migrations')
      mkdirSync(migrationsDir)
      writeFileSync(join(migrationsDir, '0000_init.sql'), 'CREATE TABLE t (id INTEGER);')
      writeFileSync(join(migrationsDir, '0001_next.sql'), 'CREATE TABLE u (id INTEGER);')
      const dbPath = join(dir, 'dev.db')
      applyLocalMigrations(dbPath, migrationsDir)
      expect(listPendingLocalMigrations(dbPath, ['0000_init.sql', '0001_next.sql'])).toEqual([])
      writeFileSync(join(migrationsDir, '0002_later.sql'), 'CREATE TABLE v (id INTEGER);')
      expect(
        listPendingLocalMigrations(dbPath, ['0000_init.sql', '0001_next.sql', '0002_later.sql']),
      ).toEqual(['0002_later.sql'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('drizzle-kit generate via shim', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloudconfig-generate-'))
    linkCloudConfigPackage(dir)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('produces a SQL migration from the config through the shim', () => {
    writeFileSync(
      join(dir, 'cloud.config.ts'),
      `import { defineBackend, model, t } from '@cloudconfig/core'

export const config = defineBackend({
  models: {
    user: model({ name: t.text().required(), email: t.email().required().unique() }),
    post: model({ title: t.text().required(), author: t.relation('user') }),
  },
})`,
    )
    writeShim(dir, join(dir, 'cloud.config.ts'), config, 'migrations')
    drizzleKitGenerate(dir, join(dir, '.cloudconfig', 'drizzle.config.ts'))

    const migrations = existsSync(join(dir, 'migrations'))
      ? readdirSync(join(dir, 'migrations')).filter((f) => f.endsWith('.sql'))
      : []
    expect(migrations.length).toBe(1)
  })

  it('runs drizzle-kit generate twice via writeShim without throwing', () => {
    const genDir = mkdtempSync(join(tmpdir(), 'cloudconfig-generate-twice-'))
    try {
      linkCloudConfigPackage(genDir)
      writeFileSync(
        join(genDir, 'cloud.config.ts'),
        `import { defineBackend, model, t } from '@cloudconfig/core'

export const config = defineBackend({
  models: {
    user: model({ name: t.text().required(), email: t.email().required().unique() }),
    post: model({ title: t.text().required(), author: t.relation('user') }),
  },
})`,
      )
      const paths1 = writeShim(genDir, join(genDir, 'cloud.config.ts'), config, 'migrations')
      drizzleKitGenerate(genDir, paths1.drizzleConfigPath)

      const configWithTag = defineBackend({
        models: {
          ...config.models,
          tag: model({ name: t.text().required() }),
        },
      })
      writeFileSync(
        join(genDir, 'cloud.config.ts'),
        `import { defineBackend, model, t } from '@cloudconfig/core'

export const config = defineBackend({
  models: {
    user: model({ name: t.text().required(), email: t.email().required().unique() }),
    post: model({ title: t.text().required(), author: t.relation('user') }),
    tag: model({ name: t.text().required() }),
  },
})`,
      )
      const paths2 = writeShim(genDir, join(genDir, 'cloud.config.ts'), configWithTag, 'migrations')
      drizzleKitGenerate(genDir, paths2.drizzleConfigPath)

      const migrations = readdirSync(join(genDir, 'migrations')).filter((f) => f.endsWith('.sql'))
      expect(migrations.length).toBeGreaterThanOrEqual(2)
    } finally {
      rmSync(genDir, { recursive: true, force: true })
    }
  })
})
