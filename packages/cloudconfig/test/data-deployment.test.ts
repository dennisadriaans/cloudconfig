import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareDatabaseDeployment, prepareDataDeployment } from '../src/cli/deployment/data.js'
import type { DeploymentRequest } from '../src/cli/deployment/ports.js'

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }))
vi.mock('@libsql/client/web', () => ({ createClient }))
let database: Database.Database
let projectDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-data-'))
  database = new Database(':memory:')
  mkdirSync(join(projectDir, 'migrations', 'meta'), { recursive: true })
  writeFileSync(
    join(projectDir, '.env'),
    'CLOUDCONFIG_DATABASE_URL=libsql://shared.example.com\nCLOUDCONFIG_DATABASE_TOKEN=database-token',
  )
  writeFileSync(
    join(projectDir, 'migrations', '0000_init.sql'),
    'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);',
  )
  writeFileSync(
    join(projectDir, 'migrations', 'meta', '0000_snapshot.json'),
    JSON.stringify({
      tables: { notes: { columns: { id: { type: 'integer' }, title: { type: 'text' } } } },
    }),
  )
  createClient.mockReturnValue({
    execute: vi.fn(async (query: string) => ({ rows: database.prepare(query).all() })),
    migrate: vi.fn(async (statements: { sql: string; args: string[] }[]) => {
      database.transaction(() => {
        for (const { sql, args } of statements) database.prepare(sql).run(...args)
      })()
    }),
    close: vi.fn(),
  })
})
afterEach(() => {
  database.close()
  rmSync(projectDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

function request(): DeploymentRequest {
  return {
    projectDir,
    configPath: join(projectDir, 'cloud.config.ts'),
    config: { models: {}, db: { remote: { provider: 'libsql' } }, deploy: { target: 'vercel' } },
    framework: 'standalone',
    target: 'vercel',
    name: 'notes-app',
    options: {},
  }
}

it('keeps database identity and rows when the host target changes', async () => {
  const project = request()
  const vercelData = prepareDatabaseDeployment(project)
  await vercelData.migrate()
  database.prepare('INSERT INTO notes (id, title) VALUES (1, ?)').run('retained')
  project.target = 'azure'
  project.config.deploy = { target: 'azure' }
  const azureData = prepareDatabaseDeployment(project)
  await azureData.migrate()
  expect(azureData.env).toEqual(vercelData.env)
  expect(database.prepare('SELECT title FROM notes').get()).toEqual({ title: 'retained' })
  expect(
    database.prepare('SELECT COUNT(*) AS count FROM _cloudconfig_remote_migrations').get(),
  ).toEqual({ count: 1 })
  expect(createClient.mock.results[0]!.value.migrate).toHaveBeenCalledOnce()
})

it('defaults Vercel to Turso and applies migrations without Cloudflare settings or Wrangler', async () => {
  const project = request()
  project.config = { models: {}, deploy: { target: 'vercel' } }
  writeFileSync(
    join(projectDir, '.env'),
    'TURSO_DATABASE_URL=libsql://notes.turso.io\nTURSO_AUTH_TOKEN=turso-token',
  )
  const data = prepareDatabaseDeployment(project)
  expect(data.env).toEqual({
    TURSO_DATABASE_URL: 'libsql://notes.turso.io',
    TURSO_AUTH_TOKEN: 'turso-token',
  })
  await data.migrate()
  await data.migrate()
  expect(createClient).toHaveBeenCalledWith({
    url: 'libsql://notes.turso.io',
    authToken: 'turso-token',
  })
  expect(
    database.prepare('SELECT COUNT(*) AS count FROM _cloudconfig_remote_migrations').get(),
  ).toEqual({
    count: 1,
  })
})

it('reports missing Turso credentials before making any database connection', () => {
  const project = request()
  project.config = { models: {}, deploy: { target: 'vercel' } }
  expect(() => prepareDatabaseDeployment(project)).toThrow('TURSO_DATABASE_URL, TURSO_AUTH_TOKEN')
  expect(createClient).not.toHaveBeenCalled()
})

it('supports custom Turso credential names on Cloudflare', async () => {
  const project = request()
  project.target = 'cloudflare'
  project.config = {
    models: {},
    db: { remote: { provider: 'turso', urlEnv: 'NOTES_DB_URL', tokenEnv: 'NOTES_DB_TOKEN' } },
  }
  writeFileSync(
    join(projectDir, '.env'),
    'NOTES_DB_URL=https://notes.turso.io\nNOTES_DB_TOKEN=notes-token',
  )
  await prepareDatabaseDeployment(project).migrate()
  expect(createClient).toHaveBeenCalledWith({
    url: 'https://notes.turso.io',
    authToken: 'notes-token',
  })
})

it('rejects local files as production libSQL databases before connecting', () => {
  writeFileSync(
    join(projectDir, '.env'),
    'CLOUDCONFIG_DATABASE_URL=file:dev.db\nCLOUDCONFIG_DATABASE_TOKEN=database-token',
  )
  expect(() => prepareDatabaseDeployment(request())).toThrow('local files are not persistent')
  expect(createClient).not.toHaveBeenCalled()
})

it.each(['environment', 'wrangler'] as const)(
  'derives R2 settings independently of Turso using the %s account',
  (source) => {
    const project = request()
    project.config = { models: {}, deploy: { target: 'vercel', r2: 'notes-files' } }
    writeFileSync(
      join(projectDir, '.env'),
      [
        'TURSO_DATABASE_URL=libsql://notes.turso.io',
        'TURSO_AUTH_TOKEN=turso-token',
        ...(source === 'environment' ? ['CLOUDFLARE_ACCOUNT_ID=storage-account'] : []),
        'CLOUDCONFIG_STORAGE_ACCESS_KEY_ID=storage-key',
        'CLOUDCONFIG_STORAGE_SECRET_ACCESS_KEY=storage-secret',
      ].join('\n'),
    )
    if (source === 'wrangler') {
      writeFileSync(
        join(projectDir, 'wrangler.jsonc'),
        JSON.stringify({ account_id: 'storage-account' }),
      )
    }
    const { env } = prepareDataDeployment(project)
    expect(env).toMatchObject({
      TURSO_DATABASE_URL: 'libsql://notes.turso.io',
      CLOUDCONFIG_STORAGE_ENDPOINT: 'https://storage-account.r2.cloudflarestorage.com',
      CLOUDCONFIG_STORAGE_BUCKET: 'notes-files',
    })
    expect(env).not.toHaveProperty('CLOUDCONFIG_D1_API_TOKEN')
    expect(env).not.toHaveProperty('CLOUDFLARE_ACCOUNT_ID')
  },
)

it('detects edited applied SQL even with --force', async () => {
  const project = request()
  await prepareDatabaseDeployment(project).migrate()
  writeFileSync(join(projectDir, 'migrations', '0000_init.sql'), 'DROP TABLE notes;')
  project.options.force = true
  await expect(prepareDatabaseDeployment(project).migrate()).rejects.toThrow('changed or removed')
  expect(database.prepare("SELECT name FROM sqlite_master WHERE name='notes'").get()).toBeDefined()
})

it('rolls back the whole migration and its ledger when a statement fails', async () => {
  const project = request()
  writeFileSync(
    join(projectDir, 'migrations', '0000_init.sql'),
    'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);\n--> statement-breakpoint\nTHIS IS INVALID SQL;',
  )
  await expect(prepareDatabaseDeployment(project).migrate()).rejects.toThrow()
  expect(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('notes', '_cloudconfig_remote_migrations')",
      )
      .all(),
  ).toEqual([])
})

it('reports a dry-run migration plan without creating tables or a ledger', async () => {
  const project = request()
  project.options.dryRun = true
  await prepareDatabaseDeployment(project).migrate()
  expect(database.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
  expect(createClient.mock.results[0]!.value.migrate).not.toHaveBeenCalled()
})

it('retains the Wrangler D1 identity across app hosts', () => {
  mkdirSync(join(projectDir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(projectDir, 'node_modules', '.bin', 'wrangler'), 'test-only binary')
  writeFileSync(
    join(projectDir, '.env'),
    'CLOUDCONFIG_D1_API_TOKEN=private-token\nCLOUDCONFIG_D1_ACCOUNT_ID=account-id',
  )
  writeFileSync(
    join(projectDir, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'original-worker',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'original-db',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
    }),
  )
  const project = request()
  project.config.db = { remote: { provider: 'd1' } }
  project.config.deploy = { target: 'vercel' }
  const vercelData = prepareDatabaseDeployment(project)
  project.target = 'azure'
  project.config.deploy = { target: 'azure' }
  expect(prepareDatabaseDeployment(project).env).toEqual(vercelData.env)
  expect(vercelData.env['CLOUDCONFIG_D1_DATABASE_ID']).toBe('00000000-0000-0000-0000-000000000001')
})
