import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { dbMigrate, dbStatus } from '../src/cli/commands/db.js'

const { createRemoteClient, loadConfig } = vi.hoisted(() => ({
  createRemoteClient: vi.fn(),
  loadConfig: vi.fn(),
}))
vi.mock('@libsql/client/web', () => ({ createClient: createRemoteClient }))
vi.mock('../src/cli/config-load.js', () => ({ loadConfig }))

let projectDir: string
let database: Client

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-turso-commands-'))
  // Reopen a file-backed client for each command, as production commands do.
  const url = `file:${join(projectDir, 'remote.db')}`
  database = createClient({ url })
  createRemoteClient.mockImplementation(() => createClient({ url }))
  loadConfig.mockResolvedValue({
    path: join(projectDir, 'cloud.config.ts'),
    config: defineBackend({
      models: { note: model({ title: t.text() }) },
      deploy: { target: 'vercel' },
    }),
  })
  mkdirSync(join(projectDir, 'migrations', 'meta'), { recursive: true })
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
  writeFileSync(
    join(projectDir, '.env'),
    'TURSO_DATABASE_URL=libsql://notes.turso.io\nTURSO_AUTH_TOKEN=notes-token',
  )
})

afterEach(() => {
  database.close()
  rmSync(projectDir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('migrates the default Vercel database remotely without a db.remote block or Wrangler', async () => {
  await dbMigrate(projectDir, true)
  expect(await database.execute('SELECT COUNT(*) AS count FROM notes')).toMatchObject({
    rows: [{ count: 0 }],
  })
  expect(createRemoteClient).toHaveBeenCalledWith({
    url: 'libsql://notes.turso.io',
    authToken: 'notes-token',
  })
})

it('reports remote Turso status without applying pending migrations', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await dbStatus(projectDir, { remote: true })
  expect(log).toHaveBeenCalledWith('Shared libSQL database: 1 pending migration(s).')
  expect(
    await database.execute("SELECT name FROM sqlite_master WHERE type = 'table'"),
  ).toMatchObject({ rows: [] })
  await dbMigrate(projectDir, true)
  log.mockClear()
  await dbStatus(projectDir, { remote: true })
  expect(log).toHaveBeenCalledWith('Shared libSQL database: 0 pending migration(s).')
})
