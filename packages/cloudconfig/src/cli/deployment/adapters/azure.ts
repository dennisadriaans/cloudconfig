import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { providerCommand } from '../command.js'
import {
  artifactDirectory,
  assertBuildOutput,
  buildProject,
  copyNextStandalone,
  nodeEntry,
} from '../build.js'
import { packageNodeEntry, zipDirectory } from '../package.js'
import type { DeploymentRequest, HostingAdapter } from '../ports.js'
import { azureAgents } from './azure-agents.js'

const appNames = new WeakMap<DeploymentRequest, string>()

function settings(request: DeploymentRequest) {
  const azure = request.config.deploy?.azure
  return {
    resourceGroup: azure?.resourceGroup ?? `${request.name}-rg`,
    location: azure?.location ?? 'westeurope',
    sku: azure?.sku ?? 'B1',
    appName: appNames.get(request) ?? request.name,
  }
}

function command(request: DeploymentRequest, args: string[]) {
  const subscription = request.config.deploy?.azure?.subscription
  return providerCommand(
    'az',
    [
      ...args,
      ...(subscription ? ['--subscription', subscription] : []),
      '--only-show-errors',
      '--output',
      'json',
    ],
    { cwd: request.projectDir },
  )
}

function agentApp(request: DeploymentRequest) {
  return azureAgents(request, {
    ...settings(request),
    plan: `${request.name}-plan`,
    command: (args) => command(request, args),
  })
}

async function packageApplication(request: DeploymentRequest): Promise<void> {
  assertBuildOutput(request)
  const directory = artifactDirectory(request)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  let entry: string
  if (request.framework === 'nuxt') {
    cpSync(join(request.projectDir, '.output'), join(directory, 'app'), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    })
    entry = 'app/server/index.mjs'
  } else if (request.framework === 'next') {
    entry = copyNextStandalone(request, directory)
  } else {
    entry = await packageNodeEntry(nodeEntry(request), directory, {
      cwd: request.projectDir,
    })
  }
  writeFileSync(
    join(directory, 'cloudconfig-start.mjs'),
    [
      `import { readFileSync, mkdirSync, symlinkSync, readlinkSync } from 'node:fs'`,
      `import { dirname } from 'node:path'`,
      `const links = JSON.parse(readFileSync(new URL('./cloudconfig-symlinks.json', import.meta.url), 'utf8'))`,
      `for (const [path, target] of Object.entries(links)) {`,
      `  mkdirSync(dirname(path), { recursive: true })`,
      `  try { symlinkSync(target, path) } catch (error) {`,
      `    if (error.code !== 'EEXIST' || readlinkSync(path) !== target) throw error`,
      `  }`,
      `}`,
      `await import('./${entry}')`,
    ].join('\n'),
  )
  await zipDirectory(directory, join(request.projectDir, '.cloudconfig', 'deploy', 'azure.zip'))
}

export const azureHosting: HostingAdapter = {
  target: 'azure',
  async check(request) {
    const output = await command(request, ['account', 'show'])
    const account = JSON.parse(output) as { id?: string; name?: string }
    if (!account.id || account.name === 'N/A(tenant level account)') {
      throw new Error(
        'Azure requires an active subscription. Enable a subscription in the Azure portal, run az login, and select it with az account set --subscription <id>.',
      )
    }
    if (!request.config.deploy?.name) {
      const identity = `${account.id}/${settings(request).resourceGroup}`
      const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 10)
      appNames.set(request, `${request.name.slice(0, 49)}-${suffix}`)
    }
  },
  async prepare() {},
  async build(request, env) {
    if (!request.options.skipBuild) await buildProject(request, env)
    await packageApplication(request)
    await agentApp(request)?.build()
  },
  async provision(request) {
    const { resourceGroup, location, sku, appName } = settings(request)
    const plan = `${request.name}-plan`
    await command(request, ['group', 'create', '--name', resourceGroup, '--location', location])
    const plans = JSON.parse(
      await command(request, ['appservice', 'plan', 'list', '--resource-group', resourceGroup]),
    ) as { name: string }[]
    if (!plans.some(({ name }) => name === plan)) {
      await command(request, [
        'appservice',
        'plan',
        'create',
        '--name',
        plan,
        '--resource-group',
        resourceGroup,
        '--is-linux',
        '--sku',
        sku,
        '--location',
        location,
      ])
    }
    const applications = JSON.parse(
      await command(request, ['webapp', 'list', '--resource-group', resourceGroup]),
    ) as { name: string }[]
    if (!applications.some(({ name }) => name === appName)) {
      await command(request, [
        'webapp',
        'create',
        '--name',
        appName,
        '--resource-group',
        resourceGroup,
        '--plan',
        plan,
        '--runtime',
        'NODE:22-lts',
      ])
    }
    await agentApp(request)?.provision()
  },
  async publish(request, env) {
    const { resourceGroup, appName } = settings(request)
    const zip = join(request.projectDir, '.cloudconfig', 'deploy', 'azure.zip')
    if (!existsSync(zip)) throw new Error('Azure deployment archive is missing.')
    const agentSettings = await agentApp(request)?.publish(env)
    if (agentSettings) Object.assign(env, agentSettings)
    const temporary = mkdtempSync(join(tmpdir(), 'cloudconfig-azure-'))
    const path = join(temporary, 'settings.json')
    try {
      writeFileSync(path, JSON.stringify({ ...env, SCM_DO_BUILD_DURING_DEPLOYMENT: 'false' }), {
        mode: 0o600,
      })
      await command(request, [
        'webapp',
        'config',
        'appsettings',
        'set',
        '--name',
        appName,
        '--resource-group',
        resourceGroup,
        '--settings',
        `@${path}`,
      ])
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
    await command(request, [
      'webapp',
      'config',
      'set',
      '--name',
      appName,
      '--resource-group',
      resourceGroup,
      '--startup-file',
      'node cloudconfig-start.mjs',
    ])
    await command(request, [
      'webapp',
      'deploy',
      '--name',
      appName,
      '--resource-group',
      resourceGroup,
      '--src-path',
      zip,
      '--type',
      'zip',
      '--clean',
      'true',
      '--restart',
      'true',
    ])
    const output = await command(request, [
      'webapp',
      'show',
      '--name',
      appName,
      '--resource-group',
      resourceGroup,
    ])
    const app = JSON.parse(output) as { defaultHostName?: string }
    if (!app.defaultHostName) throw new Error('Azure did not return an application hostname.')
    return `https://${app.defaultHostName}`
  },
}
