import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { agentDeployment, automationDeployment } from '../../../shared/worker-exports.js'
import { packageNodeEntry, zipDirectory } from '../package.js'
import type { DeploymentRequest } from '../ports.js'

interface AzureAgentOptions {
  resourceGroup: string
  location: string
  plan: string
  appName: string
  command: (args: string[]) => Promise<string>
}

/** The native execution app is versioned and deployed separately from the HTTP application. */
export function azureAgents(request: DeploymentRequest, options: AzureAgentOptions) {
  const host = agentDeployment(request.config.deploy)
  const automation = automationDeployment(request.config.deploy)
  if (!host && !automation) return
  const { command, resourceGroup, location, plan } = options
  const digest = createHash('sha256').update(`${resourceGroup}/${options.appName}`).digest('hex')
  const configured = request.config.deploy?.azure?.agents
  const appName =
    configured?.appName ?? `${options.appName.slice(0, 42)}-agents-${digest.slice(0, 10)}`
  const storageAccount = configured?.storageAccount ?? `ccagents${digest.slice(0, 16)}`
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/.test(appName)) {
    throw new Error('Azure agent appName must be 3–60 letters, digits or hyphens.')
  }
  if (!/^[a-z0-9]{3,24}$/.test(storageAccount)) {
    throw new Error('Azure agent storageAccount must be 3–24 lowercase letters or digits.')
  }
  const output = join(request.projectDir, '.cloudconfig', 'deploy', 'azure-agents')
  const zip = `${output}.zip`
  return {
    async build() {
      const projectRequire = createRequire(join(request.projectDir, 'package.json'))
      const runtimeRequire = createRequire(
        projectRequire.resolve('@cloudconfig/core/durable/azure'),
      )
      for (const dependency of ['@azure/functions', 'durable-functions', '@azure/storage-blob']) {
        try {
          runtimeRequire.resolve(dependency)
        } catch {
          throw new Error(
            `Native Azure agents require ${dependency}. Install @azure/functions, durable-functions and @azure/storage-blob in the application before deploying.`,
          )
        }
      }
      if (request.options.skipBuild) {
        if (!existsSync(zip)) {
          throw new Error('No Azure agent artifact exists. Rebuild without --skip-build.')
        }
        return
      }
      rmSync(output, { recursive: true, force: true })
      mkdirSync(output, { recursive: true })
      const source = join(request.projectDir, '.cloudconfig', 'build', 'azure-agents', 'index.mjs')
      await build({
        stdin: {
          contents: [
            `import { registerAzureWorkloads } from '@cloudconfig/core/durable/azure'`,
            ...(host
              ? [`import agent from ${JSON.stringify(join(request.projectDir, host.entry))}`]
              : []),
            ...(automation
              ? [
                  `import automationHost from ${JSON.stringify(join(request.projectDir, automation.entry))}`,
                  `import { withConnectAutomations } from '@cloudconfig/core/automations/connect'`,
                  `import { resolveConfigExport } from '@cloudconfig/core'`,
                  `import * as configModule from ${JSON.stringify(request.configPath)}`,
                  `const config = resolveConfigExport(configModule, 'cloud.config.ts')`,
                ]
              : []),
            `registerAzureWorkloads({ ${host ? 'agent,' : ''} ${automation ? 'automations: withConnectAutomations(automationHost, config)' : ''} })`,
          ].join('\n'),
          sourcefile: 'azure-agent-entry.ts',
          loader: 'ts',
          resolveDir: request.projectDir,
        },
        outfile: source,
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        target: 'node22',
      })
      const entry = await packageNodeEntry(source, output, { cwd: request.projectDir })
      writeFileSync(
        join(output, 'package.json'),
        JSON.stringify({
          private: true,
          type: 'module',
          main: 'bootstrap.mjs',
          dependencies: { '@azure/functions': '^4.16.5' },
        }),
      )
      writeFileSync(
        join(output, 'host.json'),
        JSON.stringify({
          version: '2.0',
          functionTimeout: '00:05:00',
          extensionBundle: {
            id: 'Microsoft.Azure.Functions.ExtensionBundle',
            version: '[4.0.0, 5.0.0)',
          },
          extensions: {
            durableTask: { hubName: 'CloudconfigAgents', maxConcurrentActivityFunctions: 10 },
          },
        }),
      )
      writeFileSync(
        join(output, 'bootstrap.mjs'),
        [
          `import { readFileSync, mkdirSync, symlinkSync, readlinkSync } from 'node:fs'`,
          `import { dirname, resolve } from 'node:path'`,
          `import { fileURLToPath } from 'node:url'`,
          `const root = fileURLToPath(new URL('.', import.meta.url))`,
          `const links = JSON.parse(readFileSync(new URL('./cloudconfig-symlinks.json', import.meta.url), 'utf8'))`,
          `for (const [name, target] of Object.entries(links)) {`,
          ` const path = resolve(root, name); mkdirSync(dirname(path), { recursive: true })`,
          ` try { symlinkSync(target, path) } catch (error) { if (error.code !== 'EEXIST' || readlinkSync(path) !== target) throw error }`,
          `}`,
          `await import('./${entry}')`,
        ].join('\n'),
      )
      await zipDirectory(output, zip)
    },
    async provision() {
      const accounts: { name: string }[] = JSON.parse(
        await command(['storage', 'account', 'list', '--resource-group', resourceGroup]),
      )
      if (!accounts.some(({ name }) => name === storageAccount)) {
        await command([
          'storage',
          'account',
          'create',
          '--name',
          storageAccount,
          '--resource-group',
          resourceGroup,
          '--location',
          location,
          '--sku',
          'Standard_LRS',
          '--allow-blob-public-access',
          'false',
          '--min-tls-version',
          'TLS1_2',
        ])
      }
      const apps: { name: string }[] = JSON.parse(
        await command(['functionapp', 'list', '--resource-group', resourceGroup]),
      )
      if (!apps.some(({ name }) => name === appName)) {
        await command([
          'functionapp',
          'create',
          '--name',
          appName,
          '--resource-group',
          resourceGroup,
          '--plan',
          plan,
          '--storage-account',
          storageAccount,
          '--runtime',
          'node',
          '--runtime-version',
          '22',
          '--functions-version',
          '4',
          '--os-type',
          'Linux',
        ])
      }
      await command([
        'functionapp',
        'config',
        'set',
        '--name',
        appName,
        '--resource-group',
        resourceGroup,
        '--always-on',
        'true',
      ])
    },
    async publish(env: Record<string, string>): Promise<Record<string, string>> {
      if (!existsSync(zip)) throw new Error('The Azure agent deployment archive is missing.')
      const connectionString: string = JSON.parse(
        await command([
          'storage',
          'account',
          'show-connection-string',
          '--name',
          storageAccount,
          '--resource-group',
          resourceGroup,
          '--query',
          'connectionString',
        ]),
      )
      const directory = mkdtempSync(join(tmpdir(), 'cloudconfig-azure-agents-'))
      const path = join(directory, 'settings.json')
      try {
        writeFileSync(
          path,
          JSON.stringify({
            ...env,
            AzureWebJobsStorage: connectionString,
            FUNCTIONS_WORKER_RUNTIME: 'node',
            FUNCTIONS_EXTENSION_VERSION: '~4',
            NODE_ENV: 'production',
            SCM_DO_BUILD_DURING_DEPLOYMENT: 'false',
            FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR: 'true',
            WEBSITE_RUN_FROM_PACKAGE: '0',
          }),
          { mode: 0o600 },
        )
        await command([
          'functionapp',
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
        rmSync(directory, { recursive: true, force: true })
      }
      await command([
        'functionapp',
        'deployment',
        'source',
        'config-zip',
        '--name',
        appName,
        '--resource-group',
        resourceGroup,
        '--src',
        zip,
      ])
      const keys: { functionKeys?: { default?: string } } = JSON.parse(
        await command([
          'functionapp',
          'keys',
          'list',
          '--name',
          appName,
          '--resource-group',
          resourceGroup,
        ]),
      )
      if (!keys.functionKeys?.default) {
        throw new Error(
          'Azure did not return an agent Function key. Check Function app startup logs, then retry deployment.',
        )
      }
      const app: { defaultHostName?: string } = JSON.parse(
        await command([
          'functionapp',
          'show',
          '--name',
          appName,
          '--resource-group',
          resourceGroup,
        ]),
      )
      if (!app.defaultHostName) throw new Error('Azure did not return an agent Function hostname.')
      return {
        CLOUDCONFIG_AZURE_AGENT_ENDPOINT: `https://${app.defaultHostName}/api/cloudconfig/agents`,
        CLOUDCONFIG_AZURE_AGENT_KEY: keys.functionKeys.default,
        ...(automation
          ? {
              CLOUDCONFIG_AZURE_AUTOMATION_ENDPOINT: `https://${app.defaultHostName}/api/cloudconfig/automations`,
            }
          : {}),
      }
    },
  }
}
