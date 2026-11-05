import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { azureHosting } from '../src/cli/deployment/adapters/azure.js'
import { vercelHosting } from '../src/cli/deployment/adapters/vercel.js'
import { run } from '../src/cli/exec.js'
import type { DeploymentRequest } from '../src/cli/deployment/ports.js'

vi.mock('../src/cli/exec.js', () => ({ run: vi.fn(), runInherit: vi.fn() }))
const directories: string[] = []
afterEach(() => {
  vi.resetAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function request(target: 'azure' | 'vercel'): DeploymentRequest {
  const projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-host-'))
  directories.push(projectDir)
  return {
    projectDir,
    configPath: join(projectDir, 'cloud.config.ts'),
    config: { models: {}, deploy: { target, name: 'notes-app' } },
    framework: 'standalone',
    target,
    name: 'notes-app',
    options: {},
  }
}

it('links Vercel without prompts and sends runtime secrets over stdin', async () => {
  const project = request('vercel')
  project.config.deploy!.vercel = { scope: 'my-team' }
  vi.mocked(run).mockImplementation(async (_command, args) => {
    let stdout = ''
    if (args[0] === 'deploy') stdout = 'https://notes-generated-deployment.vercel.app'
    if (args[0] === 'inspect') stdout = JSON.stringify({ aliases: ['notes.vercel.app'] })
    return { code: 0, stdout, stderr: '' }
  })
  await vercelHosting.check(project)
  await vercelHosting.prepare(project)
  const url = await vercelHosting.publish(project, {
    API_KEY: 'secret-value',
    NODE_ENV: 'production',
  })
  expect(url).toBe('https://notes.vercel.app')
  const calls = vi.mocked(run).mock.calls
  expect(
    calls.some(
      ([, args]) => args.includes('link') && args.includes('--yes') && args.includes('my-team'),
    ),
  ).toBe(true)
  const secret = calls.find(([, args]) => args[0] === 'env' && args.includes('API_KEY'))
  expect(secret?.[2].input).toBe('secret-value')
  expect(secret?.[1]).toContain('--sensitive')
  expect(calls.flatMap(([, args]) => args).join(' ')).not.toContain('secret-value')
  expect(calls.find(([, args]) => args[0] === 'deploy')?.[1]).toEqual(
    expect.arrayContaining(['--prebuilt', '--prod', '--yes']),
  )
})

it('fails before a Vercel publish if syncing a secret fails and redacts its value', async () => {
  const project = request('vercel')
  vi.mocked(run).mockResolvedValue({ code: 1, stdout: '', stderr: 'bad value: private-secret' })
  let error: unknown
  try {
    await vercelHosting.publish(project, { API_KEY: 'private-secret' })
  } catch (cause) {
    error = cause
  }
  expect(String(error)).toContain('[redacted]')
  expect(String(error)).not.toContain('private-secret')
  expect(vi.mocked(run).mock.calls.some(([, args]) => args[0] === 'deploy')).toBe(false)
})

it.each([
  { url: 'https://notes.vercel.app', readyState: 'READY' },
  { status: 'ok', deployment: { url: 'https://notes.vercel.app', readyState: 'READY' } },
])('reads Vercel deployment URLs from non-interactive JSON output: %j', async (output) => {
  const project = request('vercel')
  vi.mocked(run).mockImplementation(async (_command, args) => ({
    code: 0,
    stdout: JSON.stringify(args[0] === 'inspect' ? { aliases: ['notes.vercel.app'] } : output),
    stderr: '',
  }))
  expect(await vercelHosting.publish(project, {})).toBe('https://notes.vercel.app')
})

it('reports a missing Vercel production alias after the application was deployed', async () => {
  const project = request('vercel')
  vi.mocked(run).mockImplementation(async (_command, args) => ({
    code: 0,
    stdout:
      args[0] === 'deploy' ? 'https://notes-generated-deployment.vercel.app' : '{"aliases":[]}',
    stderr: '',
  }))
  await expect(vercelHosting.publish(project, {})).rejects.toThrow(
    'did not report a production alias',
  )
})

it('rejects missing Vercel build output before a skip-build deployment can migrate', async () => {
  const project = request('vercel')
  project.options.skipBuild = true
  await expect(vercelHosting.build(project, {})).rejects.toThrow('No Vercel build output')
  expect(run).not.toHaveBeenCalled()
})

it('rejects Cloudflare Nuxt output when skipping the Azure build', async () => {
  const project = request('azure')
  project.framework = 'nuxt'
  project.options.skipBuild = true
  mkdirSync(join(project.projectDir, '.output', 'server'), { recursive: true })
  writeFileSync(
    join(project.projectDir, '.output', 'server', 'index.mjs'),
    'export default { fetch() {} }',
  )
  writeFileSync(
    join(project.projectDir, '.output', 'nitro.json'),
    JSON.stringify({ preset: 'cloudflare-module' }),
  )
  await expect(azureHosting.build(project, {})).rejects.toThrow('not azure')
  expect(run).not.toHaveBeenCalled()
})

it('uses a private settings file for Azure and always removes it after a failure', async () => {
  const project = request('azure')
  mkdirSync(join(project.projectDir, '.cloudconfig', 'deploy'), { recursive: true })
  writeFileSync(join(project.projectDir, '.cloudconfig', 'deploy', 'azure.zip'), 'test archive')
  project.config.deploy!.azure = {
    subscription: 'subscription-a',
    resourceGroup: 'notes-resources',
  }
  let settingsPath = ''
  vi.mocked(run).mockImplementation(async (_command, args) => {
    if (args.includes('appsettings')) {
      settingsPath = args[args.indexOf('--settings') + 1]!.slice(1)
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({
        API_KEY: 'azure-secret',
      })
      return { code: 1, stdout: '', stderr: 'azure-secret' }
    }
    return { code: 0, stdout: '{}', stderr: '' }
  })
  await expect(azureHosting.publish(project, { API_KEY: 'azure-secret' })).rejects.toThrow(
    'Could not apply application settings',
  )
  expect(settingsPath).not.toBe('')
  expect(existsSync(settingsPath)).toBe(false)
  const calls = vi.mocked(run).mock.calls
  expect(calls.every(([, args]) => args.includes('subscription-a'))).toBe(true)
  expect(calls.flatMap(([, args]) => args).join(' ')).not.toContain('azure-secret')
  expect(calls.some(([, args]) => args[0] === 'webapp' && args[1] === 'deploy')).toBe(false)
})

it('reuses Azure resources and derives a stable unique default app name', async () => {
  const project = request('azure')
  delete project.config.deploy!.name
  const plans: { name: string }[] = []
  const apps: { name: string }[] = []
  vi.mocked(run).mockImplementation(async (_command, args) => {
    let output: unknown = {}
    if (args[0] === 'account') output = { id: 'subscription-a' }
    if (args.includes('list')) output = args[0] === 'appservice' ? plans : apps
    if (args[0] === 'appservice' && args.includes('create')) {
      plans.push({ name: args[args.indexOf('--name') + 1]! })
    }
    if (args[0] === 'webapp' && args[1] === 'create') {
      apps.push({ name: args[args.indexOf('--name') + 1]! })
    }
    return { code: 0, stdout: JSON.stringify(output), stderr: '' }
  })
  await azureHosting.check(project)
  await azureHosting.provision!(project)
  await azureHosting.check(project)
  await azureHosting.provision!(project)
  expect(plans).toEqual([{ name: 'notes-app-plan' }])
  expect(apps).toHaveLength(1)
  expect(apps[0]!.name).toMatch(/^notes-app-[a-f0-9]{10}$/)
})

it('rejects an Azure tenant-only login before attempting to provision resources', async () => {
  const project = request('azure')
  vi.mocked(run).mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({ id: 'tenant-id', name: 'N/A(tenant level account)' }),
    stderr: '',
  })
  await expect(azureHosting.check(project)).rejects.toThrow('Azure requires an active subscription')
  expect(run).toHaveBeenCalledTimes(1)
})
