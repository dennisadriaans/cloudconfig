import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareAutomationDeployment } from '../src/cli/deployment/automations.js'
import type { DeploymentRequest } from '../src/cli/deployment/ports.js'
import { configureAutomationRequest } from '../src/automations/configure.js'
import { provideAutomationPlatform } from '../src/automations/platform.js'
import { automationSchedules, AUTOMATION_ADMIN_KEY } from '../src/shared/automation-config.js'

const directories: string[] = []
afterEach(() => {
  provideAutomationPlatform(undefined)
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture(): DeploymentRequest {
  const projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-automation-deploy-'))
  directories.push(projectDir)
  return {
    projectDir,
    configPath: join(projectDir, 'cloud.config.ts'),
    target: 'vercel',
    framework: 'nuxt',
    name: 'fixture',
    options: {},
    config: {
      models: {},
      deploy: {
        target: 'vercel',
        automations: {
          entry: 'server/automations.ts',
          schedules: {
            daily: {
              cron: '0 0 * * *',
              timeZone: 'UTC',
              run: {
                task: 'reconcile',
                scope: { ownerId: null, workspace: 'system' },
                payload: {},
              },
            },
          },
        },
      },
    },
  }
}

it('keeps dry runs read-only and validates schedule cron before publication', async () => {
  const request = fixture()
  request.options.dryRun = true
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const prepared = prepareAutomationDeployment(request)!
  expect(prepared.env).toEqual({})
  expect(prepared.count).toBe(1)
  await prepared.configure('https://fixture.example.com')
  expect(fetch).not.toHaveBeenCalled()
  expect(existsSync(join(request.projectDir, '.env'))).toBe(false)
  request.config.deploy!.automations!.schedules!.daily!.cron = 'invalid'
  expect(() => prepareAutomationDeployment(request)).toThrow()
})

it('persists a private management key, reuses it, and sends it only to the deployed HTTPS control plane', async () => {
  const request = fixture()
  const fetch = vi.fn(async () => Response.json({ schedules: ['daily'] }))
  vi.stubGlobal('fetch', fetch)
  const prepared = prepareAutomationDeployment(request)!
  const key = prepared.env[AUTOMATION_ADMIN_KEY]!
  expect(key.length).toBeGreaterThanOrEqual(32)
  expect(readFileSync(join(request.projectDir, '.env'), 'utf8')).toContain(key)
  expect(readFileSync(join(request.projectDir, '.gitignore'), 'utf8')).toContain('.env')
  expect(prepareAutomationDeployment(request)!.env).toEqual(prepared.env)
  await expect(prepared.configure('http://fixture.example.com')).rejects.toThrow('HTTPS')
  await prepared.configure('https://fixture.example.com')
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledWith(
    new URL('https://fixture.example.com/_cloudconfig/automations/configure'),
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}` },
    }),
  )
})

it('reports publication separately when protected Vercel schedules cannot be synchronized', async () => {
  const request = fixture()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 })),
  )
  await expect(
    prepareAutomationDeployment(request)!.configure('https://fixture.example.com'),
  ).rejects.toThrow(
    'The app was published at https://fixture.example.com, but automation schedules were not synchronized',
  )
})

it('authorizes the management route and configures only source-declared jobs, including Connect housekeeping', async () => {
  const request = fixture()
  request.config.auth = { emailPassword: true }
  request.config.connect = { providers: { github: true } }
  const configure = vi.fn(async () => {})
  provideAutomationPlatform(() => ({
    configure,
    runs: vi.fn(),
    schedule: vi.fn(),
  }))
  const env = { [AUTOMATION_ADMIN_KEY]: 'private-management-key'.repeat(2) }
  const call = (method: string, key = '', body?: string) =>
    configureAutomationRequest(
      request.config,
      new Request('https://fixture.example.com/_cloudconfig/automations/configure', {
        method,
        headers: { authorization: `Bearer ${key}` },
        ...(body ? { body } : {}),
      }),
      env,
    )
  expect((await call('GET')).status).toBe(405)
  expect((await call('POST', 'forged')).status).toBe(401)
  expect(configure).not.toHaveBeenCalled()
  const response = await call(
    'POST',
    env[AUTOMATION_ADMIN_KEY],
    JSON.stringify({ evil: 'arbitrary payload' }),
  )
  expect(response.status).toBe(200)
  expect(configure).toHaveBeenCalledWith(automationSchedules(request.config))
  expect(await response.json()).toEqual({ schedules: ['daily', 'cloudconfig:connect-maintenance'] })
})
