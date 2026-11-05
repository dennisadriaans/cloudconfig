/**
 * Secrets ship with the Worker version through `--secrets-file`, so a first
 * deploy never serves requests without them. The file must be private and
 * removed afterwards, and an older wrangler still gets its secrets pushed.
 */
import {
  existsSync,
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defineBackend, model, t, type CloudConfigConfig } from '../src/index.js'
import { deployCommand } from '../src/cli/commands/deploy.js'
import { run, type RunOptions, type RunResult } from '../src/cli/cloudflare/exec.js'
import { prepareDataDeployment } from '../src/cli/deployment/data.js'

vi.mock('../src/cli/deployment/data.js', () => ({ prepareDataDeployment: vi.fn() }))

vi.mock('../src/cli/cloudflare/exec.js', () => ({
  run: vi.fn(),
  runInherit: vi.fn(),
  output: (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`,
}))

let current: CloudConfigConfig
vi.mock('../src/cli/config-load.js', () => ({
  loadConfig: async () => ({ path: 'cloud.config.ts', config: current }),
}))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
  process.exitCode = undefined
})

interface SecretsFile {
  path: string
  contents: unknown
  mode: number
}

function project(deploy: (args: string[]) => RunResult) {
  const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-secrets-'))
  dirs.push(dir)
  current = defineBackend({
    models: { note: model({ title: t.text() }) },
    deploy: { secrets: ['API_KEY'] },
  })
  mkdirSync(join(dir, 'migrations/meta'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules/.bin/wrangler'), '')
  writeFileSync(join(dir, '.env'), 'API_KEY=local-value\n')
  writeFileSync(join(dir, 'migrations/0000_init.sql'), 'CREATE TABLE notes (id INTEGER);')
  writeFileSync(
    join(dir, 'migrations/meta/0000_snapshot.json'),
    JSON.stringify({ tables: { notes: { columns: { id: { type: 'integer' } } } } }),
  )
  writeFileSync(
    join(dir, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'review-worker',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'review-db',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
    }),
  )
  const files: SecretsFile[] = []
  vi.mocked(run).mockImplementation(async (_cmd: string, args: string[], _opts: RunOptions) => {
    if (args[0] === 'whoami') return { code: 0, stdout: 'authenticated', stderr: '' }
    if (args[0] === 'secret' && args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' }
    if (args[0] === 'secret') return { code: 0, stdout: 'Uploaded', stderr: '' }
    if (args[0] === 'deploy') {
      const flag = args.indexOf('--secrets-file')
      if (flag !== -1) {
        const path = args[flag + 1]!
        files.push({
          path,
          contents: JSON.parse(readFileSync(path, 'utf8')),
          mode: statSync(path).mode & 0o777,
        })
      }
      return deploy(args)
    }
    const sql = args[args.indexOf('--command') + 1]
    const results = sql?.startsWith('SELECT')
      ? [{ name: '0000_init.sql' }]
      : [{ name: 'id', type: 'INTEGER' }]
    return { code: 0, stdout: JSON.stringify([{ results }]), stderr: '' }
  })
  return { dir, files }
}

function calls(command: string) {
  return vi.mocked(run).mock.calls.filter(([, args]) => args[0] === command)
}

it('syncs independent S3 storage credentials when the app host remains Cloudflare', async () => {
  const { dir, files } = project(() => ({
    code: 0,
    stdout: 'https://review-worker.acme.workers.dev',
    stderr: '',
  }))
  current.storage = { provider: 's3' }
  appendFileSync(
    join(dir, '.env'),
    '\nCLOUDCONFIG_STORAGE_ENDPOINT=https://storage.example.com\nCLOUDCONFIG_STORAGE_BUCKET=notes\nCLOUDCONFIG_STORAGE_ACCESS_KEY_ID=storage-id\nCLOUDCONFIG_STORAGE_SECRET_ACCESS_KEY=storage-secret\n',
  )
  await deployCommand(dir)
  expect(process.exitCode).not.toBe(1)
  expect(files[0]?.contents).toMatchObject({
    CLOUDCONFIG_STORAGE_ENDPOINT: 'https://storage.example.com',
    CLOUDCONFIG_STORAGE_BUCKET: 'notes',
    CLOUDCONFIG_STORAGE_ACCESS_KEY_ID: 'storage-id',
    CLOUDCONFIG_STORAGE_SECRET_ACCESS_KEY: 'storage-secret',
  })
})

it.each(['libsql', 'turso'] as const)(
  'uses %s on Cloudflare without provisioning D1',
  async (provider) => {
    const { dir, files } = project(() => ({
      code: 0,
      stdout: 'https://review-worker.acme.workers.dev',
      stderr: '',
    }))
    current.db = { remote: { provider } }
    writeFileSync(
      join(dir, 'wrangler.jsonc'),
      JSON.stringify({ name: 'review-worker', main: 'worker.ts' }),
    )
    const migrate = vi.fn(async () => {})
    const env =
      provider === 'turso'
        ? { TURSO_DATABASE_URL: 'libsql://shared.example.com', TURSO_AUTH_TOKEN: 'shared-token' }
        : {
            CLOUDCONFIG_DATABASE_URL: 'libsql://shared.example.com',
            CLOUDCONFIG_DATABASE_TOKEN: 'shared-token',
          }
    vi.mocked(prepareDataDeployment).mockReturnValue({
      env,
      migrate,
    })
    await deployCommand(dir)
    expect(process.exitCode).not.toBe(1)
    expect(migrate).toHaveBeenCalledOnce()
    expect(calls('d1')).toHaveLength(0)
    expect(files[0]?.contents).toMatchObject(env)
  },
)

it('uploads secrets with the Worker version from a private, removed file', async () => {
  const { dir, files } = project(() => ({
    code: 0,
    stdout: 'https://review-worker.acme.workers.dev',
    stderr: '',
  }))
  current.db = { remote: { provider: 'd1' } }

  await deployCommand(dir)

  expect(process.exitCode).not.toBe(1)
  expect(calls('deploy')).toHaveLength(1)
  expect(files).toEqual([
    { path: expect.any(String), contents: { API_KEY: 'local-value' }, mode: 0o600 },
  ])
  expect(existsSync(files[0]!.path)).toBe(false)
  expect(vi.mocked(run).mock.calls.some(([, args]) => args[1] === 'bulk')).toBe(false)
})

it('falls back to pushing secrets after deploy on a wrangler without the flag', async () => {
  const { dir } = project((args) =>
    args.includes('--secrets-file')
      ? { code: 1, stdout: '', stderr: 'Unknown arguments: secrets-file, secretsFile' }
      : { code: 0, stdout: 'https://review-worker.acme.workers.dev', stderr: '' },
  )

  await deployCommand(dir)

  expect(process.exitCode).not.toBe(1)
  expect(calls('deploy').map(([, args]) => args.includes('--secrets-file'))).toEqual([true, false])
  const bulk = vi.mocked(run).mock.calls.find(([, args]) => args[1] === 'bulk')
  expect(JSON.parse(String(bulk?.[2].input))).toEqual({ API_KEY: 'local-value' })
})

it('stops on a failed deploy without retrying or leaving the secrets file', async () => {
  const { dir, files } = project(() => ({ code: 1, stdout: '', stderr: 'Upload failed' }))

  await deployCommand(dir)

  expect(process.exitCode).toBe(1)
  expect(calls('deploy')).toHaveLength(1)
  expect(existsSync(files[0]!.path)).toBe(false)
  expect(vi.mocked(run).mock.calls.some(([, args]) => args[1] === 'bulk')).toBe(false)
})
