import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import {
  applyRemoteMigrations,
  deployWorker,
  wrangler,
} from '../src/cli/cloudflare/wrangler-ops.js'
import { run, runInherit } from '../src/cli/cloudflare/exec.js'

vi.mock('../src/cli/cloudflare/exec.js', () => ({
  run: vi.fn(),
  runInherit: vi.fn(),
  output: (outcome: { stdout: string; stderr: string }) => outcome.stdout + outcome.stderr,
}))
const directories: string[] = []
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function project(settings: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'cloudconfig-wrangler-credentials-'))
  directories.push(directory)
  for (const name of Object.keys(settings)) vi.stubEnv(name, undefined)
  writeFileSync(
    join(directory, '.env'),
    Object.entries(settings)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
  )
  vi.mocked(run).mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  return directory
}

it('keeps a D1 runtime token out of Worker authentication and deployment', async () => {
  const directory = project({ CLOUDCONFIG_D1_API_TOKEN: 'database-only-token' })
  vi.stubEnv('CLOUDFLARE_API_TOKEN', undefined)
  await wrangler(directory, ['whoami'])
  await deployWorker(directory, 'notes-app', { API_KEY: 'application-secret' })
  for (const [, , options] of vi.mocked(run).mock.calls) {
    expect(options.env).not.toHaveProperty('CLOUDFLARE_API_TOKEN')
  }
})

it('uses separate account and token scopes for D1 and Worker commands', async () => {
  const directory = project({
    CLOUDCONFIG_D1_API_TOKEN: 'database-token',
    CLOUDCONFIG_D1_ACCOUNT_ID: 'database-account',
    CLOUDFLARE_API_TOKEN: 'worker-token',
    CLOUDFLARE_ACCOUNT_ID: 'worker-account',
  })
  await wrangler(directory, ['d1', 'list'])
  await deployWorker(directory, 'notes-app')
  expect(vi.mocked(run).mock.calls[0]?.[2].env).toMatchObject({
    CLOUDFLARE_API_TOKEN: 'database-token',
    CLOUDFLARE_ACCOUNT_ID: 'database-account',
  })
  expect(vi.mocked(run).mock.calls[1]?.[2].env).toMatchObject({
    CLOUDFLARE_API_TOKEN: 'worker-token',
    CLOUDFLARE_ACCOUNT_ID: 'worker-account',
  })
})

it('passes the persistent D1 token to migration commands without an OAuth session', async () => {
  const directory = project({ CLOUDCONFIG_D1_API_TOKEN: 'database-token' })
  vi.mocked(runInherit).mockResolvedValue(0)
  expect(await applyRemoteMigrations(directory, 'notes-db')).toBe(0)
  expect(vi.mocked(runInherit).mock.calls[0]?.[2].env).toMatchObject({
    CLOUDFLARE_API_TOKEN: 'database-token',
  })
})
