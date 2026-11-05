/**
 * `deploy.domain` — the custom-domain path.
 *
 * The hostname must be validated before anything remote happens (a typo would
 * otherwise surface as a wrangler API error after the database is migrated),
 * the route must be spliced into wrangler.jsonc without clobbering routes the
 * project already declares, and a dry run must mutate nothing.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { afterEach, expect, it, vi } from 'vitest'
import { defineBackend, model, t, type CloudConfigConfig } from '../src/index.js'
import { deployCommand } from '../src/cli/commands/deploy.js'
import { run, runInherit } from '../src/cli/cloudflare/exec.js'

vi.mock('../src/cli/cloudflare/exec.js', () => ({
  run: vi.fn(),
  runInherit: vi.fn(),
  output: (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`,
}))

let current: CloudConfigConfig
vi.mock('../src/cli/config-load.js', () => ({
  loadConfig: async () => ({ path: 'cloud.config.ts', config: current }),
}))

function configWith(deploy: Record<string, unknown>): CloudConfigConfig {
  return defineBackend({ models: { note: model({ title: t.text() }) }, deploy })
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
  process.exitCode = undefined
})

function project(routes?: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-domain-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'migrations/meta'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/.bin/wrangler'), '')
  writeFileSync(join(dir, 'migrations/0000_init.sql'), 'CREATE TABLE notes (id INTEGER);')
  writeFileSync(
    join(dir, 'migrations/meta/0000_snapshot.json'),
    JSON.stringify({ tables: { notes: { columns: { id: { type: 'integer' } } } } }),
  )
  writeFileSync(
    join(dir, 'wrangler.jsonc'),
    `${JSON.stringify(
      {
        name: 'review-worker',
        account_id: 'review-account',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'review-db',
            database_id: '00000000-0000-0000-0000-000000000001',
          },
        ],
        ...(routes ? { routes } : {}),
      },
      null,
      2,
    )}\n`,
  )
  vi.mocked(run).mockImplementation(async (_cmd, args) => {
    if (args[0] === 'whoami') return { code: 0, stdout: 'authenticated', stderr: '' }
    if (args[0] === 'deploy') {
      return { code: 0, stdout: 'https://review-worker.acme.workers.dev', stderr: '' }
    }
    const sql = args[args.indexOf('--command') + 1]
    const results = sql?.startsWith('SELECT')
      ? [{ name: '0000_init.sql' }]
      : [{ name: 'id', type: 'INTEGER' }]
    return { code: 0, stdout: JSON.stringify([{ results }]), stderr: '' }
  })
  return dir
}

function routesOf(dir: string): unknown {
  return parse(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).routes
}

it('rejects a malformed domain before touching Cloudflare', async () => {
  const dir = project()
  current = configWith({ domain: 'https://api.example.com/v1' })
  const before = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')

  await deployCommand(dir)

  expect(process.exitCode).toBe(1)
  expect(run).not.toHaveBeenCalled()
  expect(runInherit).not.toHaveBeenCalled()
  expect(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).toBe(before)
})

it('adds the custom-domain route on a real deploy', async () => {
  const dir = project()
  current = configWith({ domain: 'api.example.com' })

  await deployCommand(dir)

  expect(process.exitCode).not.toBe(1)
  expect(routesOf(dir)).toEqual([{ pattern: 'api.example.com', custom_domain: true }])
})

it('keeps routes the project already declares', async () => {
  const dir = project([{ pattern: 'example.com/api/*', zone_name: 'example.com' }])
  current = configWith({ domain: 'api.example.com' })

  await deployCommand(dir)

  expect(routesOf(dir)).toEqual([
    { pattern: 'example.com/api/*', zone_name: 'example.com' },
    { pattern: 'api.example.com', custom_domain: true },
  ])
})

it('is idempotent when the domain is already routed', async () => {
  const dir = project([{ pattern: 'api.example.com', custom_domain: true, zone_id: 'zone' }])
  current = configWith({ domain: 'api.example.com' })
  const before = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')

  await deployCommand(dir)

  expect(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).toBe(before)
})

it('mutates nothing on a dry run', async () => {
  const dir = project()
  current = configWith({ domain: 'api.example.com' })
  const before = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')

  await deployCommand(dir, { dryRun: true })

  expect(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).toBe(before)
  expect(vi.mocked(run).mock.calls.some(([, args]) => args[0] === 'deploy')).toBe(false)
})
