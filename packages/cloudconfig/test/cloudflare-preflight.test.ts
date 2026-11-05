import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { dbStatus } from '../src/cli/commands/db.js'
import { deployCommand } from '../src/cli/commands/deploy.js'
import { run, runInherit } from '../src/cli/cloudflare/exec.js'

vi.mock('../src/cli/cloudflare/exec.js', () => ({
  run: vi.fn(),
  runInherit: vi.fn(),
  output: (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`,
}))
vi.mock('../src/cli/config-load.js', () => ({
  loadConfig: async () => ({
    path: 'cloud.config.ts',
    config: defineBackend({ models: { note: model({ title: t.text() }) } }),
  }),
}))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
  process.exitCode = undefined
})

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-preflight-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'migrations/meta'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/.bin/wrangler'), '')
  writeFileSync(join(dir, 'migrations/0000_init.sql'), 'CREATE TABLE notes (id INTEGER);')
  writeFileSync(join(dir, 'migrations/0001_title.sql'), 'ALTER TABLE notes ADD title TEXT;')
  for (const [index, columns] of [
    [0, { id: { type: 'integer' } }],
    [1, { id: { type: 'integer' }, title: { type: 'text' } }],
  ] as const) {
    writeFileSync(
      join(dir, `migrations/meta/000${index}_snapshot.json`),
      JSON.stringify({ tables: { notes: { columns } } }),
    )
  }
  writeFileSync(
    join(dir, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'review-worker',
      account_id: 'review-account',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'review-db',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
    }),
  )
  vi.mocked(run).mockImplementation(async (_cmd, args) => {
    if (args[0] === 'whoami') return { code: 0, stdout: 'authenticated', stderr: '' }
    expect(args.slice(0, 3)).toEqual(['d1', 'execute', 'review-db'])
    const sql = args[args.indexOf('--command') + 1]
    expect(sql).toMatch(/^(SELECT name FROM d1_migrations|PRAGMA table_info)/)
    const results = sql?.startsWith('SELECT')
      ? [{ name: '0000_init.sql' }]
      : [{ name: 'id', type: 'INTEGER' }]
    return { code: 0, stdout: JSON.stringify([{ results }]), stderr: '' }
  })
  return dir
}

it('remote status executes only metadata reads against the applied baseline', async () => {
  const dir = project()
  await dbStatus(dir, { remote: true })
  expect(run).toHaveBeenCalledTimes(2)
  expect(runInherit).not.toHaveBeenCalled()
  expect(process.exitCode).not.toBe(1)
})

it('deploy dry-run preserves config and never invokes remote mutations', async () => {
  const dir = project()
  const before = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')
  await deployCommand(dir, { dryRun: true })
  expect(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).toBe(before)
  expect(runInherit).not.toHaveBeenCalled()
  expect(run).toHaveBeenCalledTimes(3)
  expect(vi.mocked(run).mock.calls[0]?.[2].env).toEqual({
    CLOUDFLARE_ACCOUNT_ID: process.env['CLOUDFLARE_ACCOUNT_ID'] || 'review-account',
  })
  expect(process.exitCode).not.toBe(1)
})
