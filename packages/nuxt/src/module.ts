/**
 * `@cloudconfig/nuxt` — the Nuxt module.
 *
 * Everything the old scaffolded catch-all route did by hand (import the config,
 * pick a driver, mount Hono) moves in here, because the hand-written version
 * hardcoded `better-sqlite3` and never forwarded the Workers `env` — so the same
 * file could not run in dev and on Cloudflare. The module registers one server
 * handler that resolves its database per request instead.
 *
 * Mount path, local database file and D1 binding are NOT module options: they
 * come from `cloud.config.ts`, which is also what the CLI reads. Two sources
 * for one setting is how a route got registered at one path and served at
 * another.
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  addImports,
  addDevServerHandler,
  addPlugin,
  addServerHandler,
  addServerImports,
  createResolver,
  defineNuxtModule,
  useLogger,
  installModule,
  hasNuxtModule,
  resolvePath,
} from '@nuxt/kit'
import { createJiti } from 'jiti'
import type { Nuxt, NuxtModule } from '@nuxt/schema'
import type {} from '@nuxt/nitro-server/augments'
import {
  CONFIG_FILENAMES,
  resolveConfigExport,
  resolveAuth,
  resolveConnect,
  resolveProjectConfig,
  workerExports,
  agentDeployment,
  automationDeployment,
  AUTOMATION_CONFIG_PATH,
  resolveDeploymentTarget,
  deploymentPreset,
  type DeploymentTarget,
  type AgentDeployment,
  type WorkflowDeployment,
  type ResolvedProjectConfig,
} from '@cloudconfig/core'
import { writeAgentWorkflows } from './agent-workflows.js'
import { writeAutomationWorkflows, writeWorkloadPlatforms } from './automation-workflows.js'

export interface ModuleOptions {
  /** Config path relative to the root. Auto-detects cloud.config.ts, then cloudconfig.config.ts. */
  config?: string
  /**
   * Server-only module whose default export resolves the caller from the
   * request (`(request) => user | null`). Relative to the project root.
   * Auto-detected at `server/cloudconfig/user.ts`.
   */
  getUser?: string
  /** Register the `useCloudConfig()` composable. */
  client?: boolean
  /** Configure the Nitro Workers build used by `cloudconfig init --cloudflare`. */
  cloudflare?: boolean
  /** Show the development-only database toolbar. Defaults to true. */
  studio?: boolean
}

interface ProjectSettings {
  target?: DeploymentTarget
  agents: AgentDeployment[]
  automations?: AgentDeployment
  workflows: WorkflowDeployment[]
  project: ResolvedProjectConfig
  /** Absolute mount path of the auth routes, when the config enables auth. */
  authBasePath?: string
  twoFactor?: { passkey: boolean }
  /** Absolute mount path of the Connect routes, when the config has a connect block. */
  connectBasePath?: string
  scim?: boolean
  storagePaths: Record<string, string>
}

const USER_MODULE_NAMES = [
  'server/cloudconfig/user.ts',
  'server/cloudconfig/user.js',
  'server/cloudconfig/user.mjs',
]

function findFirst(rootDir: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const path = join(rootDir, name)
    if (existsSync(path)) return path
  }
  return undefined
}

/**
 * Read the project contract out of the user's config at build time. Loading the
 * config here is safe: `defineBackend` is an identity function that never
 * touches a database, and a broken import should fail the build loudly rather
 * than at the first request.
 */
async function readProjectConfig(configPath: string): Promise<ProjectSettings> {
  const jiti = createJiti(import.meta.url)
  const mod: Record<string, unknown> = await jiti.import(configPath)
  const typed = resolveConfigExport(mod, configPath)
  const auth = resolveAuth(typed)
  const connect = resolveConnect(typed)
  const agent = agentDeployment(typed.deploy)
  const automation = automationDeployment(typed.deploy)
  workerExports(typed.deploy)
  return {
    ...(typed.deploy?.target !== undefined
      ? { target: resolveDeploymentTarget(typed.deploy.target) }
      : {}),
    agents: agent ? [agent] : [],
    ...(automation ? { automations: automation } : {}),
    workflows: typed.deploy?.workflows ?? [],
    project: resolveProjectConfig(typed),
    storagePaths: Object.fromEntries(
      Object.entries(typed.models)
        .filter(([, model]) => model.options.storage?.path)
        .map(([name, model]) => [name, model.options.storage!.path!]),
    ),
    ...(auth ? { authBasePath: auth.basePath } : {}),
    ...(auth?.twoFactor ? { twoFactor: { passkey: auth.twoFactor.passkey !== false } } : {}),
    ...(connect ? { connectBasePath: connect.basePath } : {}),
    ...(auth?.scim ? { scim: true } : {}),
  }
}

const cloudconfigModule: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@cloudconfig/nuxt',
    configKey: 'cloudconfig',
    compatibility: { nuxt: '>=3.13.0' },
  },
  defaults: {
    client: true,
    studio: true,
  },
  async setup(options: ModuleOptions, nuxt: Nuxt) {
    const logger = useLogger('cloudconfig')
    const resolver = createResolver(import.meta.url)

    const configPath = options.config
      ? join(nuxt.options.rootDir, options.config)
      : findFirst(nuxt.options.rootDir, CONFIG_FILENAMES)
    if (configPath && !CONFIG_FILENAMES.some((name) => name === basename(configPath))) {
      throw new Error(
        `CloudConfig supports ${CONFIG_FILENAMES.join(' or ')}. Rename your config file and update cloudconfig.config.`,
      )
    }
    if (!configPath || !existsSync(configPath)) {
      logger.warn('No cloud.config.ts found — run `cloudconfig init`. The backend is not mounted.')
      return
    }

    const settings = await readProjectConfig(configPath)
    const hasDurableDeclarations =
      settings.agents.length > 0 || settings.workflows.length > 0 || !!settings.automations
    const target =
      settings.target ?? (options.cloudflare || hasDurableDeclarations ? 'cloudflare' : undefined)
    if (target) {
      // cloud.config.ts is authoritative, including over the legacy cloudflare module flag.
      nuxt.options.nitro.preset = deploymentPreset(target)
      if (target === 'cloudflare') {
        nuxt.options.nitro.cloudflare = {
          ...nuxt.options.nitro.cloudflare,
          nodeCompat: true,
          deployConfig: false,
        }
      }
      if (!nuxt.options.dev && target !== 'cloudflare' && settings.workflows.length) {
        throw new Error(
          'Cloudflare Workflow classes require deploy.target "cloudflare" in production.',
        )
      }
    }
    const { project, authBasePath, storagePaths, twoFactor, connectBasePath, scim } = settings
    if (authBasePath) {
      nuxt.hook('nitro:config', (config) => {
        // Passkey verification initializes Reflect before loading tsyringe.
        // Nitro otherwise drops this side-effect-only import from Worker bundles.
        config.moduleSideEffects ??= []
        if (!config.moduleSideEffects.includes('reflect-metadata')) {
          config.moduleSideEffects.push('reflect-metadata')
        }
      })
    }
    const resolveEntry = <T extends { entry: string }>(entry: T): T => {
      const path = join(nuxt.options.rootDir, entry.entry)
      if (!existsSync(path)) throw new Error(`CloudConfig deployment entry does not exist: ${path}`)
      return { ...entry, entry: path }
    }
    const agents = settings.agents.map(resolveEntry)
    const automations = settings.automations ? resolveEntry(settings.automations) : undefined
    const workflows = settings.workflows.map(resolveEntry)
    let workflowEntry: string | undefined
    let platformEntry: string | undefined
    if (!nuxt.options.dev && target === 'vercel' && (agents[0] || automations)) {
      if (!hasNuxtModule('workflow')) await installModule('workflow/nuxt')
      // Resolve through the public package: pnpm does not expose workflow's transitive @workflow/nitro dependency.
      const workflowNitro = await resolvePath('workflow/nitro', { cwd: nuxt.options.rootDir })
      nuxt.options.nitro.modules = (nuxt.options.nitro.modules ?? []).map((module) =>
        module === '@workflow/nitro' ? workflowNitro : module,
      )
      if (agents[0]) {
        workflowEntry = writeAgentWorkflows({
          rootDir: nuxt.options.rootDir,
          hostEntry: agents[0].entry,
          configPath,
        })
      }
      if (automations) writeAutomationWorkflows(nuxt.options.rootDir)
      platformEntry = writeWorkloadPlatforms({
        rootDir: nuxt.options.rootDir,
        configPath,
        ...(agents[0] ? { agentEntry: agents[0].entry } : {}),
        ...(automations ? { automationEntry: automations.entry } : {}),
      })
    }
    const agentsUtil = resolver.resolve('./runtime/server/agents')
    const automationsUtil = resolver.resolve('./runtime/server/automations')
    // Workflow classes import cloudflare:workers; agent hosts are platform-free and typechecked.
    nuxt.hook('prepare:types', ({ tsConfig }) => {
      tsConfig.exclude ??= []
      tsConfig.exclude.push(...workflows.map((entry) => entry.entry))
      // Layer and module server code is typechecked with the app config too.
      if (agents.length) {
        tsConfig.compilerOptions ??= {}
        tsConfig.compilerOptions.paths ??= {}
        tsConfig.compilerOptions.paths['#cloudconfig/agents'] = [agentsUtil]
      }
      if (automations) {
        tsConfig.compilerOptions ??= {}
        tsConfig.compilerOptions.paths ??= {}
        tsConfig.compilerOptions.paths['#cloudconfig/automations'] = [automationsUtil]
      }
    })
    if (agents.length) {
      nuxt.options.nitro.alias = { ...nuxt.options.nitro.alias, '#cloudconfig/agents': agentsUtil }
      addServerImports({ name: 'useCloudConfigAgents', from: agentsUtil })
    }
    if (automations) {
      nuxt.options.nitro.alias = {
        ...nuxt.options.nitro.alias,
        '#cloudconfig/automations': automationsUtil,
      }
      addServerImports({ name: 'useCloudConfigAutomations', from: automationsUtil })
      addServerHandler({
        route: AUTOMATION_CONFIG_PATH,
        handler: resolver.resolve('./runtime/server/automation-configure'),
      })
    }
    nuxt.hook('nitro:init', (nitro) => {
      const cloudflare = !nitro.options.dev && !!nitro.options.preset?.includes('cloudflare')
      if (
        !nitro.options.dev &&
        hasDurableDeclarations &&
        target &&
        nitro.options.preset?.replaceAll('_', '-') !== deploymentPreset(target).replaceAll('_', '-')
      ) {
        throw new Error(
          `Agent deployment target ${target} requires the ${deploymentPreset(target)} Nitro preset; received ${nitro.options.preset}.`,
        )
      }
      if (!nitro.options.dev && workflows.length && !cloudflare) {
        throw new Error('Cloudflare Workflow classes require a Cloudflare Workers build.')
      }
      const host = agents[0]
      // The composition root: bind the agent platform adapter for this build target.
      if (host) {
        let plugin: string[]
        if (cloudflare) {
          plugin = [
            `import { provideAgentPlatform } from '@cloudconfig/core/agents/platform'`,
            `import { cloudflareAgentPlatform } from '@cloudconfig/core/agents/cloudflare/client'`,
            `export default () => provideAgentPlatform((env) => cloudflareAgentPlatform(env?.[${JSON.stringify(host.binding)}]))`,
          ]
        } else if (nitro.options.dev) {
          plugin = [
            `import { provideAgentPlatform, createMemoryAgentPlatform } from '@cloudconfig/core/agents/platform'`,
            `import host from ${JSON.stringify(host.entry)}`,
            `export default () => {`,
            `  const platform = createMemoryAgentPlatform(host, { env: process.env })`,
            `  provideAgentPlatform(() => platform)`,
            `}`,
          ]
        } else if (target === 'vercel' && workflowEntry && platformEntry) {
          plugin = [
            `import { bindPlatforms } from ${JSON.stringify(platformEntry)}`,
            `export default bindPlatforms`,
          ]
        } else if (target === 'azure') {
          plugin = [
            `import { provideAgentPlatform } from '@cloudconfig/core/agents/platform'`,
            `import { azureAgentPlatform } from '@cloudconfig/core/agents/azure/client'`,
            `export default () => provideAgentPlatform(() => azureAgentPlatform())`,
          ]
        } else {
          throw new Error(
            'Agent deployments require deploy.target cloudflare, vercel or azure and its matching build preset. Production never uses the memory agent adapter.',
          )
        }
        nitro.options.virtual['#cloudconfig/agent-platform'] = plugin.join('\n')
        nitro.options.plugins.push('#cloudconfig/agent-platform')
      }
      if (automations) {
        let plugin: string[]
        if (cloudflare) {
          plugin = [
            `import { provideAutomationPlatform } from '@cloudconfig/core/automations'`,
            `import { cloudflareAutomationPlatform } from '@cloudconfig/core/automations/cloudflare/client'`,
            `export default () => provideAutomationPlatform(env => cloudflareAutomationPlatform(env?.[${JSON.stringify(automations.binding)}]))`,
          ]
        } else if (nitro.options.dev) {
          plugin = [
            `import { provideAutomationPlatform, createMemoryAutomationPlatform } from '@cloudconfig/core/automations'`,
            `import { withConnectAutomations } from '@cloudconfig/core/automations/connect'`,
            `import { resolveConfigExport, automationSchedules } from '@cloudconfig/core'`,
            `import host from ${JSON.stringify(automations.entry)}`,
            `import * as configModule from ${JSON.stringify(configPath)}`,
            `export default async () => {`,
            `  const config = resolveConfigExport(configModule, 'cloud.config.ts')`,
            `  const platform = createMemoryAutomationPlatform(withConnectAutomations(host, config), { env: process.env })`,
            `  provideAutomationPlatform(() => platform)`,
            `  await platform.configure(automationSchedules(config))`,
            `}`,
          ]
        } else if (target === 'vercel' && platformEntry) {
          plugin = [
            `import { bindPlatforms } from ${JSON.stringify(platformEntry)}`,
            `export default bindPlatforms`,
          ]
        } else if (target === 'azure') {
          plugin = [
            `import { provideAutomationPlatform } from '@cloudconfig/core/automations'`,
            `import { azureAutomationPlatform } from '@cloudconfig/core/automations/azure/client'`,
            `export default () => provideAutomationPlatform(() => azureAutomationPlatform())`,
          ]
        } else {
          throw new Error(
            'Automation deployment requires a native Cloudflare, Vercel or Azure build.',
          )
        }
        nitro.options.virtual['#cloudconfig/automation-platform'] = plugin.join('\n')
        nitro.options.plugins.push('#cloudconfig/automation-platform')
      }
      if (!cloudflare || (!agents.length && !workflows.length && !automations)) return
      const previous = nitro.options.entry
      nitro.options.virtual['#cloudconfig-worker-entry'] = [
        `export { default } from ${JSON.stringify(previous)}; export * from ${JSON.stringify(previous)};`,
        ...(host
          ? [
              `import { createCloudflareAgent } from '@cloudconfig/core/agents/cloudflare';`,
              `import cloudconfigAgentHost from ${JSON.stringify(host.entry)};`,
              `export const ${host.className} = createCloudflareAgent(cloudconfigAgentHost);`,
              `import { provideAgentPlatform } from '@cloudconfig/core/agents/platform';`,
              `import { cloudflareAgentPlatform } from '@cloudconfig/core/agents/cloudflare/client';`,
              `provideAgentPlatform(env => cloudflareAgentPlatform(env?.[${JSON.stringify(host.binding)}]));`,
            ]
          : []),
        ...(automations
          ? [
              `import { createCloudflareAutomations } from '@cloudconfig/core/automations/cloudflare';`,
              `import { withConnectAutomations } from '@cloudconfig/core/automations/connect';`,
              `import { resolveConfigExport } from '@cloudconfig/core';`,
              `import automationHost from ${JSON.stringify(automations.entry)};`,
              `import * as automationConfig from ${JSON.stringify(configPath)};`,
              `export const ${automations.className} = createCloudflareAutomations(withConnectAutomations(automationHost, resolveConfigExport(automationConfig, 'cloud.config.ts')), { binding: ${JSON.stringify(automations.binding)} });`,
            ]
          : []),
        ...workflows.map(
          (entry) => `export { ${entry.className} } from ${JSON.stringify(entry.entry)};`,
        ),
      ].join('\n')
      nitro.options.entry = '#cloudconfig-worker-entry'
    })

    // The handler imports the user's config through this alias, so the app's own
    // bundler compiles it — no second copy, no jiti at runtime.
    nuxt.options.alias['#cloudconfig/config'] = configPath
    nuxt.options.nitro.alias = { ...nuxt.options.nitro.alias, '#cloudconfig/config': configPath }

    // The identity port: a server-only module, so nothing about session lookup
    // can be pulled into the client bundle.
    const userModule = options.getUser
      ? join(nuxt.options.rootDir, options.getUser)
      : findFirst(nuxt.options.rootDir, USER_MODULE_NAMES)
    if (options.getUser && !existsSync(userModule as string)) {
      throw new Error(`cloudconfig.getUser points at ${userModule}, which does not exist.`)
    }
    const userAlias = userModule ?? resolver.resolve('./runtime/server/anonymous')
    nuxt.options.nitro.alias = { ...nuxt.options.nitro.alias, '#cloudconfig/user': userAlias }

    nuxt.options.runtimeConfig.cloudconfig = {
      basePath: project.basePath,
      d1Binding: project.d1Binding,
      localDb: project.localDbPath,
      ...(nuxt.options.runtimeConfig.cloudconfig as Record<string, unknown> | undefined),
    }
    nuxt.options.runtimeConfig.public.cloudconfig = {
      basePath: project.basePath,
      storagePaths,
      ...(authBasePath ? { authBasePath } : {}),
      ...(twoFactor ? { twoFactor } : {}),
      ...(connectBasePath ? { connectBasePath } : {}),
      ...(nuxt.options.runtimeConfig.public.cloudconfig as Record<string, unknown> | undefined),
    }

    if (nuxt.options.dev && options.studio !== false && process.env['NODE_ENV'] !== 'production') {
      const { createStudioDevtools, STUDIO_PATH } = await import('@cloudconfig/core/devtools')
      const localDb = (nuxt.options.runtimeConfig.cloudconfig as Record<string, unknown>)['localDb']
      const studio = createStudioDevtools({
        projectDir: nuxt.options.rootDir,
        databasePath: typeof localDb === 'string' ? localDb : project.localDbPath,
      })
      nuxt.hook('close', () => studio.dispose())
      addDevServerHandler({
        route: `${nuxt.options.app.baseURL.replace(/\/$/, '')}${STUDIO_PATH}`,
        handler: async (event) => {
          const { req, res } = event.node
          const headers = new Headers()
          for (const [name, value] of Object.entries(req.headers)) {
            if (value != null) {
              headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
            }
          }
          const protocol = nuxt.options.devServer.https ? 'https' : 'http'
          const request = new Request(
            `${protocol}://${req.headers.host ?? 'localhost'}${STUDIO_PATH}`,
            {
              method: req.method ?? 'GET',
              headers,
            },
          )
          const response = await studio.handle(request)
          res.statusCode = response.status
          response.headers.forEach((value, name) => res.setHeader(name, value))
          return response.text()
        },
      })
      addPlugin({ src: resolver.resolve('./runtime/plugins/studio.client'), mode: 'client' })
    }

    // `better-sqlite3` is a native module: it must stay outside the server bundle
    // in dev, and it is never reached on a Workers build (the D1 branch wins).
    nuxt.options.nitro.externals = {
      ...nuxt.options.nitro.externals,
      external: [...(nuxt.options.nitro.externals?.external ?? []), 'better-sqlite3'],
    }

    const handler = resolver.resolve('./runtime/server/handler')
    const serverClient = resolver.resolve('./runtime/server/client')
    nuxt.options.nitro.alias = { ...nuxt.options.nitro.alias, '#cloudconfig/server': serverClient }
    addServerImports({ name: 'useCloudConfigServer', from: serverClient })
    if (connectBasePath) {
      addServerImports({
        name: 'useCloudConfigConnectServer',
        from: resolver.resolve('./runtime/server/connect'),
      })
    }
    // Two routes: `/api/**` does not match a request for `/api` itself.
    const wildcard = project.basePath === '/' ? '/**' : `${project.basePath}/**`
    addServerHandler({ route: project.basePath, handler })
    addServerHandler({ route: wildcard, handler })
    if (
      authBasePath &&
      project.basePath !== '/' &&
      authBasePath !== project.basePath &&
      !authBasePath.startsWith(`${project.basePath}/`)
    ) {
      addServerHandler({ route: authBasePath, handler })
      addServerHandler({ route: `${authBasePath}/**`, handler })
    }
    if (
      connectBasePath &&
      project.basePath !== '/' &&
      !connectBasePath.startsWith(`${project.basePath}/`)
    ) {
      addServerHandler({ route: `${connectBasePath}/**`, handler })
    }

    if (options.client !== false) {
      addImports({
        name: 'useCloudConfig',
        as: 'useCloudConfig',
        from: resolver.resolve('./runtime/composables/cloudconfig'),
      })
      addImports({
        name: 'useCloudConfigTable',
        as: 'useCloudConfigTable',
        from: resolver.resolve('./runtime/composables/table'),
      })
      // Only with auth on: the composable imports `better-auth/vue`, which a
      // project without sign-in has no reason to have installed.
      if (authBasePath) {
        if (twoFactor) {
          addImports({
            name: 'useCloudConfigTwoFactor',
            as: 'useCloudConfigTwoFactor',
            from: resolver.resolve('./runtime/composables/two-factor'),
          })
        }
        addImports({
          name: 'useCloudConfigAdmin',
          as: 'useCloudConfigAdmin',
          from: resolver.resolve('./runtime/composables/admin'),
        })
        addImports({
          name: 'useCloudConfigAccount',
          as: 'useCloudConfigAccount',
          from: resolver.resolve('./runtime/composables/account'),
        })
        addImports({
          name: 'useCloudConfigOrganizations',
          as: 'useCloudConfigOrganizations',
          from: resolver.resolve('./runtime/composables/organizations'),
        })
        addImports({
          name: 'useCloudConfigAuth',
          as: 'useCloudConfigAuth',
          from: resolver.resolve('./runtime/composables/auth'),
        })
        if (scim) {
          addImports({
            name: 'useCloudConfigScim',
            as: 'useCloudConfigScim',
            from: resolver.resolve('./runtime/composables/scim'),
          })
        }
        if (connectBasePath) {
          addImports({
            name: 'useCloudConfigConnect',
            as: 'useCloudConfigConnect',
            from: resolver.resolve('./runtime/composables/connect'),
          })
        }
      }
    }

    const configLabel = configPath.replace(`${nuxt.options.rootDir}/`, '')
    logger.info(`CloudConfig mounted at ${project.basePath} (${configLabel})`)
    if (userModule) {
      logger.info(`Identity resolved by ${userModule.replace(`${nuxt.options.rootDir}/`, '')}`)
    } else if (authBasePath) {
      logger.info(`Auth mounted at ${authBasePath} (useCloudConfigAuth() on the client)`)
    }
  },
})

export default cloudconfigModule
