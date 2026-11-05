/**
 * `cloudconfig deploy` for projects configured by cf's `cloudflare.config.ts`.
 *
 * cf owns the Worker definition; CloudConfig must still refuse undeclared secrets
 * before touching the database, migrate before the upload, and ship secrets in
 * the uploaded version through a file that never outlives the deploy.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defineBackend, model, t, type CloudConfigConfig } from '../src/index.js'
import { cloudflareBindings } from '../src/cloudflare.js'
import { deployCommand } from '../src/cli/commands/deploy.js'
import { BUILD_OUTPUT_WORKER_CONFIG } from '../src/cli/cloudflare/cf-ops.js'
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

const DATABASE_ID = '00000000-0000-0000-0000-000000000001'

function configWith(deploy: Record<string, unknown> = {}): CloudConfigConfig {
  return defineBackend({
    models: { note: model({ title: t.text() }) },
    db: { name: 'notes-db' },
    deploy: { secrets: ['API_KEY'], ...deploy },
  })
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = undefined
})

interface Remote {
  databases?: Array<{ uuid: string; name: string }>
  applied?: string[]
}

function project(env: Record<string, unknown>, remote: Remote = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-cf-deploy-'))
  dirs.push(dir)
  vi.stubEnv('API_KEY', undefined)
  mkdirSync(join(dir, 'migrations/meta'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/.bin/cf'), '')
  writeFileSync(join(dir, 'cloudflare.config.ts'), 'export default {}\n')
  writeFileSync(join(dir, '.env'), 'API_KEY=application-secret\n')
  writeFileSync(join(dir, 'migrations/0000_init.sql'), 'CREATE TABLE notes (id INTEGER);')
  writeFileSync(
    join(dir, 'migrations/meta/0000_snapshot.json'),
    JSON.stringify({ tables: { notes: { columns: { id: { type: 'integer' } } } } }),
  )

  const databases = remote.databases ?? [{ uuid: DATABASE_ID, name: 'notes-db' }]
  const applied = remote.applied ?? []
  const uploads: Array<Record<string, string>> = []
  vi.mocked(run).mockImplementation(async (_command, args) => {
    const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
    if (args[0] === 'auth') return json({ authenticated: true })
    if (args[0] === 'workers') return json([])
    if (args[1] === 'list') return json(databases.filter(({ name }) => name === args[3]))
    if (args[1] === 'create') return json({ uuid: 'created-id', name: args[3] })
    const sql = args[args.indexOf('--sql') + 1] ?? ''
    if (sql.startsWith('SELECT')) {
      return json([{ results: applied.map((name) => ({ name })) }])
    }
    return json([{ results: applied.length ? [{ name: 'id', type: 'INTEGER' }] : [] }])
  })
  vi.mocked(runInherit).mockImplementation(async (_command, args) => {
    if (args[0] === 'build') {
      const path = join(dir, BUILD_OUTPUT_WORKER_CONFIG)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ name: 'notes', env, domains: ['notes.example.com'] }))
    }
    if (args[0] === 'd1') applied.push('0000_init.sql')
    if (args[0] === 'deploy') {
      const file = args[args.indexOf('--secrets-file') + 1] as string
      uploads.push(JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>)
    }
    return 0
  })
  return { dir, uploads }
}

function inheritedCommands(): string[] {
  return vi.mocked(runInherit).mock.calls.map(([, args]) => args.join(' '))
}

it('derives the D1 binding, R2 bucket and secrets from cloud.config.ts', () => {
  expect(cloudflareBindings(configWith({ r2: 'notes-files' }))).toEqual({
    API_KEY: { type: 'secret' },
    DB: { type: 'd1', name: 'notes-db' },
    BUCKET: { type: 'r2', name: 'notes-files' },
  })
})

it('requires a D1 database name', () => {
  const config = defineBackend({ models: { note: model({ title: t.text() }) } })
  expect(() => cloudflareBindings(config)).toThrow(/db\.name/)
  expect(cloudflareBindings(config, { databaseName: 'notes-db', databaseId: 'id' })).toEqual({
    DB: { type: 'd1', name: 'notes-db', id: 'id' },
  })
})

it('migrates by database id before uploading the version with its secrets', async () => {
  current = configWith()
  const { dir, uploads } = project(cloudflareBindings(current))

  await deployCommand(dir)

  expect(process.exitCode).toBeUndefined()
  expect(inheritedCommands()).toEqual([
    'build',
    `d1 migrations apply ${DATABASE_ID} --dir migrations`,
    expect.stringMatching(/^deploy --prebuilt --secrets-file /),
  ])
  expect(uploads).toEqual([{ API_KEY: 'application-secret' }])
  const file = vi.mocked(runInherit).mock.calls.at(-1)?.[1].at(-1) as string
  expect(existsSync(file)).toBe(false)
})

it('refuses an undeclared secret before touching the database', async () => {
  current = configWith()
  const { dir } = project({ DB: { type: 'd1', name: 'notes-db' } })

  await deployCommand(dir)

  expect(process.exitCode).toBe(1)
  expect(inheritedCommands()).toEqual(['build'])
})

it('creates a missing database so migrations run before the upload', async () => {
  current = configWith()
  const { dir } = project(cloudflareBindings(current), { databases: [] })

  await deployCommand(dir)

  expect(process.exitCode).toBeUndefined()
  expect(inheritedCommands()[1]).toBe('d1 migrations apply created-id --dir migrations')
})

it('creates, migrates and uploads nothing on a dry run', async () => {
  current = configWith()
  const { dir } = project(cloudflareBindings(current), { databases: [] })

  await deployCommand(dir, { dryRun: true })

  expect(process.exitCode).toBeUndefined()
  expect(inheritedCommands()).toEqual(['build'])
  expect(vi.mocked(run).mock.calls.some(([, args]) => args[1] === 'create')).toBe(false)
})

it('requires deploy.domain in the cf config', async () => {
  current = configWith({ domain: 'other.example.com' })
  const { dir } = project(cloudflareBindings(current))

  await deployCommand(dir)

  expect(process.exitCode).toBe(1)
  expect(inheritedCommands()).toEqual(['build'])
})

it('refuses an ambiguous project with both config formats', async () => {
  current = configWith()
  const { dir } = project(cloudflareBindings(current))
  writeFileSync(join(dir, 'wrangler.jsonc'), '{ "name": "notes" }\n')

  await deployCommand(dir)

  expect(process.exitCode).toBe(1)
  expect(run).not.toHaveBeenCalled()
  expect(runInherit).not.toHaveBeenCalled()
})

it('keeps durable declarations on the Wrangler path', async () => {
  current = configWith({ workflows: [{ binding: 'FLOW', className: 'Flow', entry: 'flow.ts' }] })
  const { dir } = project(cloudflareBindings(current))

  await deployCommand(dir)

  expect(process.exitCode).toBe(1)
  expect(runInherit).not.toHaveBeenCalled()
})
