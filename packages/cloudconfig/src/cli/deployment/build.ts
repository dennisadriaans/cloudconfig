import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { build } from 'esbuild'
import { detectPackageManager, runScriptCommand } from '../package-manager.js'
import { deploymentPreset } from '../../shared/deployment-target.js'
import { runInherit } from '../exec.js'
import { ensureNextStandalone } from './next-standalone.js'
import type { DeploymentRequest } from './ports.js'

export function artifactDirectory(request: DeploymentRequest): string {
  return join(request.projectDir, '.cloudconfig', 'deploy', request.target)
}

/** Framework build adapter: select a preset or prepare the framework's portable server output. */
export async function buildProject(
  request: DeploymentRequest,
  env: Record<string, string>,
): Promise<void> {
  const { projectDir, framework, target } = request
  if (framework === 'standalone') {
    await buildStandalone(request)
    return
  }
  if (framework === 'next' && target === 'azure') ensureNextStandalone(projectDir)
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  if (!pkg.scripts?.['build']) {
    throw new Error('Add a build script to package.json before deploying.')
  }
  const [command, ...args] = runScriptCommand(detectPackageManager(projectDir), 'build').split(' ')
  const code = await runInherit(command!, args, {
    cwd: projectDir,
    env: { ...env, NITRO_PRESET: deploymentPreset(target), CLOUDCONFIG_DEPLOY_TARGET: target },
  })
  if (code !== 0) {
    throw new Error('Build failed. No database migrations or app deployment were performed.')
  }
}

async function buildStandalone(request: DeploymentRequest): Promise<void> {
  const { projectDir, configPath, config, target } = request
  const directory = join(projectDir, '.cloudconfig', 'build', target)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  const backend = config.deploy?.entry
    ? `import app from ${JSON.stringify(join(projectDir, config.deploy.entry))}`
    : [
        `import { resolveConfigExport } from '@cloudconfig/core'`,
        `import { createBackend } from '@cloudconfig/core/server'`,
        `import { configuredDatabase } from '@cloudconfig/core/drivers/configured'`,
        `import * as configModule from ${JSON.stringify(configPath)}`,
        `const config = resolveConfigExport(configModule, 'cloud.config.ts')`,
        `const app = createBackend(config, { db: configuredDatabase(config) })`,
      ].join('\n')
  const fetchHandler = [
    `const fetch = (request: Request) => {`,
    // Both hosts terminate TLS before forwarding to the Node listener.
    `  if (process.env.VERCEL === '1' || process.env.WEBSITE_HOSTNAME) {`,
    `    const url = new URL(request.url)`,
    `    url.protocol = 'https:'`,
    `    request = new Request(url, request)`,
    `  }`,
    `  return app.fetch(request, process.env)`,
    `}`,
  ].join('\n')
  const entry =
    target === 'vercel'
      ? `${backend}\n${fetchHandler}\nimport { getRequestListener } from '@hono/node-server'\nexport default getRequestListener(fetch)\n`
      : `${backend}\n${fetchHandler}\nimport { serve } from '@hono/node-server'\nserve({ fetch, port: Number(process.env.PORT || 8080), hostname: '0.0.0.0' })\n`
  await build({
    stdin: {
      contents: entry,
      resolveDir: projectDir,
      sourcefile: 'cloudconfig-entry.ts',
      loader: 'ts',
    },
    outfile: join(directory, 'index.mjs'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })
}

/** Node entry for Azure; Nuxt already traces dependencies into its output folder. */
export function nodeEntry(request: DeploymentRequest): string {
  if (request.framework === 'standalone') {
    return join(request.projectDir, '.cloudconfig', 'build', request.target, 'index.mjs')
  }
  if (request.framework === 'nuxt') {
    return join(request.projectDir, '.output', 'server', 'index.mjs')
  }
  return join(nextStandaloneDirectory(request.projectDir), 'server.js')
}

export function assertBuildOutput(request: DeploymentRequest): void {
  if (request.framework === 'nuxt') {
    const metadata = join(request.projectDir, '.output', 'nitro.json')
    if (!existsSync(metadata)) {
      throw new Error(
        'Missing Nuxt build metadata. Build for the selected deployment target first.',
      )
    }
    const build = JSON.parse(readFileSync(metadata, 'utf8')) as { preset?: string }
    if (build.preset !== deploymentPreset(request.target)) {
      throw new Error(
        `Nuxt output was built for ${build.preset ?? 'an unknown preset'}, not ${request.target}. Run cloudconfig deploy without --skip-build.`,
      )
    }
  }
  const path =
    request.framework === 'next'
      ? join(request.projectDir, '.next', 'BUILD_ID')
      : nodeEntry(request)
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Build for ${request.target} before using --skip-build.`)
  }
}

export function nextStandaloneDirectory(projectDir: string): string {
  const manifest = join(projectDir, '.next', 'required-server-files.json')
  if (!existsSync(manifest)) {
    throw new Error('Missing Next.js build metadata. Run the build before deploying.')
  }
  const build = JSON.parse(readFileSync(manifest, 'utf8')) as {
    appDir: string
    config: { outputFileTracingRoot?: string; output?: string }
  }
  if (build.config.output !== 'standalone') {
    throw new Error(
      "Next.js output must use output: 'standalone'. Check config wrappers or build-script overrides, then rebuild without --skip-build.",
    )
  }
  const root = build.config.outputFileTracingRoot ?? build.appDir
  const appPath = relative(root, build.appDir)
  return join(projectDir, '.next', 'standalone', appPath)
}

export function copyNextStandalone(request: DeploymentRequest, directory: string): string {
  const { projectDir } = request
  const standalone = nextStandaloneDirectory(projectDir)
  const appPath = relative(join(projectDir, '.next', 'standalone'), standalone)
  cpSync(join(projectDir, '.next', 'standalone'), join(directory, 'app'), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (path) => !/^\.env(?:\.|$)/.test(basename(path)),
  })
  const metadata = JSON.parse(
    readFileSync(join(projectDir, '.next', 'required-server-files.json'), 'utf8'),
  ) as {
    appDir: string
    config: { outputFileTracingRoot?: string }
  }
  rebaseNextLinks(join(directory, 'app'), {
    traceRoot: metadata.config.outputFileTracingRoot ?? metadata.appDir,
    sourceOutput: join(projectDir, '.next', 'standalone'),
  })
  const application = join(directory, 'app', appPath)
  cpSync(join(projectDir, '.next', 'static'), join(application, '.next', 'static'), {
    recursive: true,
  })
  if (existsSync(join(projectDir, 'public'))) {
    cpSync(join(projectDir, 'public'), join(application, 'public'), { recursive: true })
  }
  return join('app', appPath, 'server.js').replaceAll('\\', '/')
}

/** Next may preserve absolute workspace symlinks; point them at the copied traced files. */
function rebaseNextLinks(
  directory: string,
  options: { traceRoot: string; sourceOutput: string },
): void {
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const path = join(entry.parentPath, entry.name)
    const target = readlinkSync(path)
    if (!isAbsolute(target)) continue
    const outputRelative = relative(options.sourceOutput, target)
    const isInOutput =
      outputRelative !== '..' &&
      !outputRelative.startsWith('..' + sep) &&
      !isAbsolute(outputRelative)
    const targetRelative = isInOutput ? outputRelative : relative(options.traceRoot, target)
    if (
      targetRelative === '..' ||
      targetRelative.startsWith('..' + sep) ||
      isAbsolute(targetRelative)
    ) {
      throw new Error(
        'A Next.js dependency lies outside outputFileTracingRoot. Include the dependency workspace and rebuild before deploying.',
      )
    }
    unlinkSync(path)
    symlinkSync(relative(dirname(path), join(directory, targetRelative)), path)
  }
}
