import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { resolveDeploymentTarget, deploymentPreset } from '../src/shared/deployment-target.js'
import { deployHostedProject } from '../src/cli/deployment/deploy.js'
import type { DeploymentRequest, HostingAdapter } from '../src/cli/deployment/ports.js'

const { migrate, prepareData } = vi.hoisted(() => ({ migrate: vi.fn(), prepareData: vi.fn() }))
vi.mock('../src/cli/deployment/data.js', () => ({ prepareDataDeployment: prepareData }))

afterEach(() => vi.resetAllMocks())

function fixture() {
  const events: string[] = []
  const env = { CLOUDCONFIG_D1_ACCOUNT_ID: 'account' }
  prepareData.mockReturnValue({ env, migrate })
  migrate.mockImplementation(async () => {
    events.push('migrate')
    Object.assign(env, { CLOUDCONFIG_D1_DATABASE_ID: 'provisioned' })
  })
  const request: DeploymentRequest = {
    projectDir: '/tmp/deployment',
    configPath: '/tmp/deployment/cloud.config.ts',
    config: defineBackend({ models: { note: model({ title: t.text() }) } }),
    framework: 'standalone',
    target: 'azure',
    name: 'notes-app',
    options: {},
  }
  const host: HostingAdapter = {
    target: 'azure',
    check: vi.fn(async () => {
      events.push('check')
    }),
    prepare: vi.fn(async () => {
      events.push('prepare')
    }),
    build: vi.fn(async () => {
      events.push('build')
    }),
    publish: vi.fn(async () => {
      events.push('publish')
      return 'https://notes.example.com'
    }),
  }
  return { request, host, events }
}

describe('deployment orchestration', () => {
  it('builds before migrating and publishes the provisioned data identity', async () => {
    const { request, host, events } = fixture()
    await deployHostedProject(request, host)
    expect(events).toEqual(['check', 'prepare', 'build', 'migrate', 'publish'])
    expect(host.publish).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        CLOUDCONFIG_D1_DATABASE_ID: 'provisioned',
        NODE_ENV: 'production',
      }),
    )
  })

  it('does not migrate or publish a failed build', async () => {
    const { request, host } = fixture()
    vi.mocked(host.build).mockRejectedValue(new Error('build broke'))
    await expect(deployHostedProject(request, host)).rejects.toThrow('build broke')
    expect(migrate).not.toHaveBeenCalled()
    expect(host.publish).not.toHaveBeenCalled()
  })

  it('does not publish after a failed migration', async () => {
    const { request, host } = fixture()
    migrate.mockRejectedValue(new Error('schema drift'))
    await expect(deployHostedProject(request, host)).rejects.toThrow('schema drift')
    expect(host.publish).not.toHaveBeenCalled()
  })

  it('does not migrate when post-build hosting provisioning fails', async () => {
    const { request, host } = fixture()
    host.provision = vi.fn(async () => {
      throw new Error('Azure quota exceeded')
    })
    await expect(deployHostedProject(request, host)).rejects.toThrow('Azure quota exceeded')
    expect(migrate).not.toHaveBeenCalled()
    expect(host.publish).not.toHaveBeenCalled()
  })

  it('reports retained database changes when publishing fails', async () => {
    const { request, host } = fixture()
    vi.mocked(host.publish).mockRejectedValue(new Error('provider refused'))
    await expect(deployHostedProject(request, host)).rejects.toThrow(
      'Database changes were retained',
    )
    expect(migrate).toHaveBeenCalledOnce()
  })

  it('does not call any provider or migration on a dry run', async () => {
    const { request, host, events } = fixture()
    request.options.dryRun = true
    request.config.deploy = { agent: { entry: 'server/agents.ts' } }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await deployHostedProject(request, host)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('private Storage account'))
      expect(events).toEqual([])
      expect(migrate).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('still validates build artifacts with --skip-build before migrating', async () => {
    const { request, host, events } = fixture()
    request.options.skipBuild = true
    await deployHostedProject(request, host)
    expect(events.indexOf('build')).toBeLessThan(events.indexOf('migrate'))
  })

  it('rejects missing application secrets before any host action', async () => {
    const { request, host, events } = fixture()
    request.config.deploy = { secrets: ['CLOUDCONFIG_TEST_ABSENT_SECRET'] }
    await expect(deployHostedProject(request, host)).rejects.toThrow(
      'CLOUDCONFIG_TEST_ABSENT_SECRET',
    )
    expect(events).toEqual([])
  })

  it('rejects Cloudflare Workflow classes on other hosts before provisioning', async () => {
    const { request, host, events } = fixture()
    request.config.deploy = {
      workflows: [
        { entry: 'workflow.ts', className: 'Workflow', binding: 'WORKFLOW', name: 'workflow' },
      ],
    }
    await expect(deployHostedProject(request, host)).rejects.toThrow('does not support')
    expect(events).toEqual([])
  })

  it.each(['azure', 'vercel'] as const)(
    'accepts a portable native agent host on %s',
    async (target) => {
      const { request, host } = fixture()
      request.target = target
      request.framework = 'nuxt'
      request.config.deploy = { target, agent: { entry: 'server/cloudconfig/agents.ts' } }
      await deployHostedProject(request, host)
      expect(host.publish).toHaveBeenCalledOnce()
    },
  )
})

describe('deployment target contract', () => {
  it('preserves existing Cloudflare projects', () => {
    expect(resolveDeploymentTarget(undefined)).toBe('cloudflare')
  })
  it.each(['azure', 'vercel', 'cloudflare'] as const)('resolves %s', (target) => {
    expect(resolveDeploymentTarget(target)).toBe(target)
  })
  it('rejects misspellings instead of publishing to the default host', () => {
    expect(() => resolveDeploymentTarget('azurre')).toThrow('Unknown deploy.target')
  })
  it('selects the build preset from the host target', () => {
    expect(deploymentPreset('azure')).toBe('node-server')
    expect(deploymentPreset('vercel')).toBe('vercel')
    expect(deploymentPreset('cloudflare')).toBe('cloudflare_module')
  })
})
