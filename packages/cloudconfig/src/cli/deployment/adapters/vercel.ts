import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSecretValues } from '../../cloudflare/secrets.js'
import { isValidCustomDomain } from '../../cloudflare/wrangler-config.js'
import { providerCommand } from '../command.js'
import { buildProject } from '../build.js'
import { packageNodeEntry } from '../package.js'
import type { DeploymentRequest, HostingAdapter } from '../ports.js'

function command(
  request: DeploymentRequest,
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
) {
  const scope = request.config.deploy?.vercel?.scope
  const { values } = resolveSecretValues(
    ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'],
    request.projectDir,
  )
  return providerCommand('vercel', [...args, ...(scope ? ['--scope', scope] : [])], {
    cwd: request.projectDir,
    ...options,
    env: { ...values, ...options.env },
  })
}

async function packageStandalone(request: DeploymentRequest): Promise<void> {
  const output = join(request.projectDir, '.vercel', 'output')
  const directory = join(output, 'functions', 'index.func')
  mkdirSync(directory, { recursive: true })
  const entry = join(request.projectDir, '.cloudconfig', 'build', 'vercel', 'index.mjs')
  const handler = await packageNodeEntry(entry, directory, { cwd: request.projectDir })
  writeFileSync(
    join(directory, '.vc-config.json'),
    JSON.stringify(
      {
        runtime: 'nodejs22.x',
        handler,
        launcherType: 'Nodejs',
        supportsResponseStreaming: true,
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(output, 'config.json'),
    JSON.stringify({ version: 3, routes: [{ src: '/(.*)', dest: '/index' }] }, null, 2),
  )
}

/** Newer Vercel CLIs return JSON automatically in non-interactive/agent sessions. */
function deploymentUrl(stdout: string): string | undefined {
  if (!stdout.startsWith('{')) {
    return stdout.split(/\s+/).findLast((part) => /^https:\/\/[^\s]+$/.test(part))
  }
  const payload: unknown = JSON.parse(stdout)
  if (typeof payload !== 'object' || payload === null) return
  const deployment = 'deployment' in payload ? payload.deployment : payload
  if (typeof deployment !== 'object' || deployment === null || !('url' in deployment)) return
  const { url } = deployment
  if (typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url)) return url
}

export const vercelHosting: HostingAdapter = {
  target: 'vercel',
  async check(request) {
    await command(request, ['whoami'])
  },
  async prepare(request) {
    const project =
      request.config.deploy?.vercel?.project ??
      request.config.deploy?.name ??
      (existsSync(join(request.projectDir, '.vercel', 'project.json')) ? undefined : request.name)
    await command(request, ['link', '--yes', ...(project ? ['--project', project] : [])])
    await command(request, ['pull', '--yes', '--environment=production'])
  },
  async build(request, env) {
    const output = join(request.projectDir, '.vercel', 'output', 'config.json')
    if (request.options.skipBuild) {
      if (!existsSync(output)) {
        throw new Error(
          'No Vercel build output. Run cloudconfig deploy without --skip-build first.',
        )
      }
      return
    }
    rmSync(join(request.projectDir, '.vercel', 'output'), { recursive: true, force: true })
    if (request.framework === 'next') {
      await command(request, ['build', '--prod', '--yes'], { env })
    } else {
      await buildProject(request, env)
      if (request.framework === 'standalone') await packageStandalone(request)
    }
    if (!existsSync(output)) {
      throw new Error(
        'The build did not produce .vercel/output/config.json. Check the Vercel build preset.',
      )
    }
  },
  async publish(request, env) {
    for (const [name, value] of Object.entries(env)) {
      // stdin keeps credentials out of process arguments and shell histories.
      const visibility =
        /^(?:NUXT_PUBLIC_|NEXT_PUBLIC_)/.test(name) || name === 'NODE_ENV'
          ? '--no-sensitive'
          : '--sensitive'
      await command(request, ['env', 'add', name, 'production', '--force', '--yes', visibility], {
        input: value,
      })
    }
    const stdout = await command(request, ['deploy', '--prebuilt', '--prod', '--yes'])
    const url = deploymentUrl(stdout)
    if (!url) {
      throw new Error(
        'Vercel returned success without a deployment URL. Check the Vercel dashboard before deploying again.',
      )
    }
    if (request.config.deploy?.domain) {
      await command(request, ['alias', 'set', url, request.config.deploy.domain])
      return `https://${request.config.deploy.domain}`
    }
    // Generated deployment URLs can require Vercel login even for production builds.
    const details: unknown = JSON.parse(
      await command(request, ['inspect', url, '--format', 'json']),
    )
    const aliases: unknown[] =
      typeof details === 'object' &&
      details !== null &&
      'aliases' in details &&
      Array.isArray(details.aliases)
        ? details.aliases
        : []
    const alias = aliases.find(
      (value): value is string => typeof value === 'string' && isValidCustomDomain(value),
    )
    if (!alias) {
      throw new Error(
        'Vercel deployed the application but did not report a production alias. Check the project domains in Vercel before deploying again.',
      )
    }
    return `https://${alias}`
  },
}
