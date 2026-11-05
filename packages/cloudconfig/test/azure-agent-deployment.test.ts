import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { azureAgents } from '../src/cli/deployment/adapters/azure-agents.js'
import type { DeploymentRequest } from '../src/cli/deployment/ports.js'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(options: { automations?: boolean; agent?: boolean } = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-azure-agents-'))
  directories.push(projectDir)
  const request: DeploymentRequest = {
    projectDir,
    configPath: join(projectDir, 'cloud.config.ts'),
    framework: 'nuxt',
    target: 'azure',
    name: 'notes-app',
    options: {},
    config: {
      models: {},
      deploy: {
        target: 'azure',
        ...(options.agent === false ? {} : { agent: { entry: 'server/agents.ts' } }),
        ...(options.automations ? { automations: { entry: 'server/automations.ts' } } : {}),
        azure: {
          agents: { appName: 'notes-agent-functions', storageAccount: 'notesagentstorage' },
        },
      },
    },
  }
  const settingsFiles: { path: string; value: Record<string, string>; mode: number }[] = []
  const command = vi.fn(async (args: string[]): Promise<string> => {
    if (args[0] === 'storage' && args[2] === 'list') return '[]'
    if (args[0] === 'functionapp' && args[1] === 'list') return '[]'
    if (args.includes('show-connection-string')) return JSON.stringify('private-storage-connection')
    if (args[1] === 'keys') {
      return JSON.stringify({ functionKeys: { default: 'private-agent-key' } })
    }
    if (args[1] === 'show') {
      return JSON.stringify({ defaultHostName: 'notes-agent-functions.azurewebsites.net' })
    }
    const file = args[args.indexOf('--settings') + 1]
    if (args.includes('--settings') && file?.startsWith('@')) {
      const path = file.slice(1)
      settingsFiles.push({
        path,
        value: JSON.parse(readFileSync(path, 'utf8')),
        mode: statSync(path).mode & 0o777,
      })
    }
    return '{}'
  })
  const deployment = azureAgents(request, {
    resourceGroup: 'notes-rg',
    location: 'westeurope',
    plan: 'notes-plan',
    appName: 'notes-app',
    command,
  })!
  return { request, projectDir, command, deployment, settingsFiles }
}

it('provisions native Functions and private Storage separately from the web application', async () => {
  const { deployment, command } = fixture()
  await deployment.provision()
  expect(command).toHaveBeenCalledWith(
    expect.arrayContaining(['storage', 'account', 'create', '--allow-blob-public-access', 'false']),
  )
  expect(command).toHaveBeenCalledWith(
    expect.arrayContaining([
      'functionapp',
      'create',
      '--plan',
      'notes-plan',
      '--storage-account',
      'notesagentstorage',
      '--runtime-version',
      '22',
    ]),
  )
  expect(command).toHaveBeenCalledWith(
    expect.arrayContaining(['functionapp', 'config', 'set', '--always-on', 'true']),
  )
})

it('deploys the Function artifact with private settings and returns only server gateway credentials', async () => {
  const { deployment, projectDir, command, settingsFiles } = fixture()
  mkdirSync(join(projectDir, '.cloudconfig/deploy'), { recursive: true })
  writeFileSync(join(projectDir, '.cloudconfig/deploy/azure-agents.zip'), 'fixture archive')
  const env = await deployment.publish({ OPENAI_API_KEY: 'private-provider-key' })
  expect(env).toEqual({
    CLOUDCONFIG_AZURE_AGENT_ENDPOINT:
      'https://notes-agent-functions.azurewebsites.net/api/cloudconfig/agents',
    CLOUDCONFIG_AZURE_AGENT_KEY: 'private-agent-key',
  })
  expect(settingsFiles[0]).toMatchObject({
    mode: 0o600,
    value: {
      OPENAI_API_KEY: 'private-provider-key',
      AzureWebJobsStorage: 'private-storage-connection',
      FUNCTIONS_WORKER_RUNTIME: 'node',
    },
  })
  expect(existsSync(settingsFiles[0]!.path)).toBe(false)
  expect(command.mock.calls.flat(2).join(' ')).not.toMatch(
    /private-(?:agent|provider)-key|private-storage-connection/,
  )
})

it('packages the real native Function worker and its traced dependencies', async () => {
  const { deployment, projectDir } = fixture()
  mkdirSync(join(projectDir, 'server'), { recursive: true })
  mkdirSync(join(projectDir, 'node_modules/@cloudconfig'), { recursive: true })
  symlinkSync(
    join(import.meta.dirname, '..'),
    join(projectDir, 'node_modules/@cloudconfig/core'),
    'dir',
  )
  writeFileSync(
    join(projectDir, 'server/agents.ts'),
    `
export default { async resolve() { throw new Error('Fixture: no real model calls') } }
`,
  )
  await deployment.build()
  const output = join(projectDir, '.cloudconfig/deploy/azure-agents')
  expect(JSON.parse(readFileSync(join(output, 'host.json'), 'utf8'))).toMatchObject({
    version: '2.0',
    extensions: { durableTask: { hubName: 'CloudconfigAgents' } },
  })
  expect(JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'))).toMatchObject({
    main: 'bootstrap.mjs',
  })
  expect(readFileSync(join(output, 'bootstrap.mjs'), 'utf8')).toContain('cloudconfig-symlinks.json')
  expect(existsSync(`${output}.zip`)).toBe(true)
}, 30_000)

it.each([false, true])(
  'packages native automations with agent host enabled=%s',
  async (agent) => {
    const { deployment, projectDir, request } = fixture({ agent, automations: true })
    mkdirSync(join(projectDir, 'server'), { recursive: true })
    mkdirSync(join(projectDir, 'node_modules/@cloudconfig'), { recursive: true })
    symlinkSync(
      join(import.meta.dirname, '..'),
      join(projectDir, 'node_modules/@cloudconfig/core'),
      'dir',
    )
    writeFileSync(request.configPath, `export default ${JSON.stringify(request.config)}`)
    writeFileSync(
      join(projectDir, 'server/automations.ts'),
      `
export default { async authorize() {}, tasks: { async reconcile(payload, context) {
  return context.step('reconcile', async () => payload)
} } }
`,
    )
    if (agent) {
      writeFileSync(
        join(projectDir, 'server/agents.ts'),
        `export default { async resolve() { throw new Error('Unused model') } }`,
      )
    }
    await deployment.build()
    const env = await deployment.publish({ PRIVATE_SETTING: 'server-only' })
    expect(env).toMatchObject({
      CLOUDCONFIG_AZURE_AUTOMATION_ENDPOINT:
        'https://notes-agent-functions.azurewebsites.net/api/cloudconfig/automations',
      CLOUDCONFIG_AZURE_AGENT_KEY: 'private-agent-key',
    })
    const source = readFileSync(
      join(projectDir, '.cloudconfig/build/azure-agents/index.mjs'),
      'utf8',
    )
    expect(source).toContain('registerAzureWorkloads')
    expect(source).toContain('automations:')
  },
  30000,
)
