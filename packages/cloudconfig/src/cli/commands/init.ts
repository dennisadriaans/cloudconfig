/**
 * `cloudconfig init` — scaffolds cloud.config.ts, wires the framework mount file (or
 * a standalone entry), and records the detected framework. Idempotent: never
 * overwrites files that already exist.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import pc from 'picocolors'
import { agentFiles } from '../agent-files.js'
import { detectFramework, type Framework } from '../detect.js'
import { findConfigPath } from '../config-load.js'
import { ensureGitignored } from '../auth-env.js'
import { ENV_FILE } from '../cloudflare/secrets.js'
import { ensureFrameworkExternals, type FrameworkExternalsResult } from '../framework-externals.js'
import { packageNameFor } from '../package-name.js'
import {
  detectPackageManager,
  installCommand,
  runScriptCommand,
  runnerFor,
  type PackageManager,
} from '../package-manager.js'
import {
  mcpConfigFor,
  mountFileFor,
  withConfigFilename,
  STANDALONE_ENTRY,
  STANDALONE_WORKER,
  STARTER_CONFIG,
} from '../scaffold.js'
import { configureStandaloneCloudflare } from '../standalone-cloudflare.js'
import {
  ensureNuxtModule,
  ensureNuxtCloudflare,
  ensureNuxtUiModule,
  NUXT_MODULE_NAME,
  type NuxtModuleResult,
} from '../nuxt-module.js'
import {
  configureCloudflare,
  cloudconfigDependencies,
  prepareNuxtPackage,
  prepareNuxtProjectFiles,
  prepareNuxtSecret,
  preflightNuxtDashboardTemplate,
  writeNuxtDashboardTemplate,
  NUXT_DASHBOARD_DEPENDENCIES,
} from '../nuxt-setup.js'
import { DASHBOARD_STARTER_CONFIG } from '../dashboard-starter.js'
import { ensureNuxtServerFolder } from '../nuxt-server-template.js'
import { ensurePnpmBuilds } from '../pnpm-builds.js'

function writeIfMissing(path: string, content: string): 'written' | 'skipped' {
  if (existsSync(path)) return 'skipped'
  const dir = dirname(path)
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, content)
  return 'written'
}

export interface InitOptions {
  /** Force a target instead of detecting one (`cloudconfig init --target next`). */
  target?: Framework
  /** Configure the complete Nuxt Workers deployment path. */
  cloudflare?: boolean
  /** Auth starter config, with an application shell for Nuxt. */
  template?: 'dashboard'
}

export function initCommand(projectDir: string, opts: InitOptions = {}): void {
  const framework = opts.target ?? detectFramework(projectDir)
  if (opts.cloudflare && framework !== 'nuxt') {
    throw new Error('--cloudflare setup currently supports --target nuxt only.')
  }
  if (opts.template && framework !== 'nuxt' && framework !== 'standalone') {
    throw new Error('--template dashboard supports --target nuxt and --target standalone.')
  }
  if (opts.template === 'dashboard' && framework === 'nuxt') {
    preflightNuxtDashboardTemplate(projectDir)
  }
  mkdirSync(projectDir, { recursive: true })
  const newNuxtProject =
    framework === 'nuxt' && prepareNuxtPackage(projectDir, opts.template === 'dashboard')
  const pm = detectPackageManager(projectDir)
  console.log(pc.bold(`\nCloudConfig init — detected: ${pc.cyan(framework)}\n`))

  const existing = findConfigPath(projectDir)
  const configPath = existing ?? join(projectDir, 'cloud.config.ts')
  const configFilename = basename(configPath)
  const configResult = existing
    ? 'skipped'
    : writeIfMissing(
        configPath,
        opts.template === 'dashboard' ? DASHBOARD_STARTER_CONFIG : STARTER_CONFIG,
      )
  report(configFilename, configResult)

  report(
    '.env.example',
    writeIfMissing(
      join(projectDir, '.env.example'),
      '# Store local values in .env; keep this file free of credentials.\nBETTER_AUTH_SECRET=\n',
    ),
  )

  // Write or merge package.json before `.mcp.json` so the MCP server key can
  // use the package name. Standalone / Nuxt / Next all fill missing scripts and
  // local sqlite tooling; existing keys are left alone.
  if (framework === 'standalone') {
    ensureStandalonePackageJson(projectDir)
  } else {
    ensureFrameworkPackageJson(projectDir, framework, opts.template === 'dashboard')
  }

  // Include pnpm defaults even when init ran through npm/npx: the first install
  // may use pnpm, which blocks dependency install scripts by default.
  const pnpmBuilds = ensurePnpmBuilds(projectDir)
  if (pnpmBuilds === 'written') {
    report('pnpm-workspace.yaml (dependency builds)', 'written')
  } else {
    console.log(
      pc.dim(
        '  Existing pnpm configuration preserved. If builds are blocked, run pnpm approve-builds.',
      ),
    )
  }

  // Register the MCP server so an agent (Claude Code, …) can manage the backend.
  // Key = sanitized package.json name so multiple projects in one workspace do
  // not collide; runner matches the package manager so `cloudconfig` resolves locally.
  const mcpName = packageNameFor(projectDir)
  const runner = runnerFor(pm, 'cloudconfig', ['mcp'])
  const mcpResult = writeIfMissing(join(projectDir, '.mcp.json'), mcpConfigFor(mcpName, runner))
  report('.mcp.json', mcpResult)

  if (framework === 'standalone') {
    const entryResult = writeIfMissing(
      join(projectDir, 'server.ts'),
      withConfigFilename(STANDALONE_ENTRY, configFilename),
    )
    report('server.ts', entryResult)
    report(
      'worker.ts',
      writeIfMissing(
        join(projectDir, 'worker.ts'),
        withConfigFilename(STANDALONE_WORKER, configFilename),
      ),
    )
    configureStandaloneCloudflare(projectDir)
    report('wrangler.jsonc (Worker + D1 provisioning)', 'written')
    if (!existing) prepareNuxtSecret(projectDir)
  } else if (framework === 'nuxt') {
    if (newNuxtProject) prepareNuxtProjectFiles(projectDir)
    if (!existing) prepareNuxtSecret(projectDir)
    // The module owns the mount, the driver choice and the nitro externals.
    const result = ensureNuxtModule(projectDir)
    reportNuxtModule(result)
    if (result.status === 'manual') throw new Error(result.hint)
    // Always present: where the backend is configured, and how to add a route.
    for (const file of ensureNuxtServerFolder(projectDir, pm)) report(file, 'written')
    if (opts.template === 'dashboard') {
      const uiResult = ensureNuxtUiModule(projectDir)
      reportNuxtModule(uiResult, '@nuxt/ui')
      if (uiResult.status === 'manual') throw new Error(uiResult.hint)
      const files = writeNuxtDashboardTemplate(projectDir, configFilename)
      report(`Nuxt UI dashboard template (${files.length} files)`, 'written')
    }
    if (opts.cloudflare) {
      ensureNuxtCloudflare(projectDir)
      configureCloudflare(projectDir)
      report('wrangler.jsonc (Nuxt Worker + assets)', 'written')
    }
  } else {
    const mount = mountFileFor(framework, configFilename)
    if (mount) {
      const mountResult = writeIfMissing(join(projectDir, mount.path), mount.content)
      report(mount.path, mountResult)
    }
    reportExternals(ensureFrameworkExternals(projectDir, framework))
  }

  ensureGitignored(projectDir, ENV_FILE)
  for (const file of agentFiles()) {
    report(file.path, writeIfMissing(join(projectDir, file.path), file.content))
  }

  console.log(pc.dim(`\n  Project directory: ${projectDir}`))
  printNextSteps(framework, pm, mcpName)
}

function report(name: string, result: 'written' | 'skipped'): void {
  const icon = result === 'written' ? pc.green('+') : pc.dim('•')
  const label = result === 'written' ? name : pc.dim(`${name} (exists)`)
  console.log(`  ${icon} ${label}`)
}

function reportExternals(result: FrameworkExternalsResult): void {
  if (result.status === 'noop') return
  const name = basename(result.path)
  if (result.status === 'written') {
    report(name, 'written')
    return
  }
  if (result.status === 'updated') {
    console.log(`  ${pc.green('~')} ${name} (better-sqlite3 external)`)
    return
  }
  if (result.status === 'skipped') {
    report(name, 'skipped')
    return
  }
  console.log(`  ${pc.yellow('!')} ${pc.yellow(name)} — ${result.hint}`)
}

function reportNuxtModule(result: NuxtModuleResult, moduleName = NUXT_MODULE_NAME): void {
  const name = basename(result.path)
  if (result.status === 'manual') {
    console.log(`  ${pc.yellow('!')} ${pc.yellow(name)} — ${result.hint}`)
    return
  }
  if (result.status === 'updated') {
    console.log(`  ${pc.green('~')} ${name} (${moduleName})`)
    return
  }
  report(name, result.status)
}

/**
 * The four commands that take a fresh project to a deployed backend. Keep this
 * a numbered path rather than a list of capabilities: the point of `init` is
 * that there is exactly one road out of it.
 */
function printNextSteps(framework: string, pm: PackageManager, mcpName: string): void {
  const generate = runScriptCommand(pm, 'db:generate')
  const migrate = runScriptCommand(pm, 'db:migrate')
  const deploy = runnerFor(pm, 'cloudconfig', ['deploy'])

  console.log(pc.bold('\n  Next:\n'))
  console.log(`    1. ${installCommand(pm)}`)
  if (framework === 'standalone') {
    console.log(
      `    2. ${pc.cyan([deploy.command, ...deploy.args].join(' '))}${pc.dim('   → D1 + Worker on Cloudflare')}`,
    )
    console.log(
      pc.dim(`    Local development: ${generate} && ${migrate} && ${runScriptCommand(pm, 'dev')}`),
    )
    console.log(
      pc.dim(
        '    Cloudflare account: sign in once with wrangler login, or set CLOUDFLARE_API_TOKEN.',
      ),
    )
    console.log(pc.dim(`  Check anytime:  ${runScriptCommand(pm, 'doctor')}`))
    console.log(pc.dim(`  Agents:         .mcp.json registers the MCP server as "${mcpName}"\n`))
    return
  }
  console.log(`    2. ${generate} && ${migrate}`)
  console.log(
    framework === 'nuxt'
      ? `    3. ${runScriptCommand(pm, 'typecheck')}`
      : `    3. ${runScriptCommand(pm, 'dev')}${pc.dim('   \u2192 API on :3000, docs at /api/_docs')}`,
  )
  console.log(
    `    4. ${pc.cyan([deploy.command, ...deploy.args].join(' '))}${pc.dim('   \u2192 D1 + Worker on Cloudflare')}`,
  )

  console.log(pc.dim('\n  GitHub sign-in: cloudconfig auth add github'))
  console.log(
    pc.dim('  Custom domain:  set deploy.domain in cloud.config.ts, then cloudconfig deploy'),
  )
  if (framework === 'nuxt') {
    console.log(
      pc.dim('  D1 on deploy:   the module reads the binding per request, no code change.'),
    )
  }
  console.log(pc.dim(`  Check anytime:  ${runScriptCommand(pm, 'doctor')}`))
  console.log(pc.dim(`  Agents:         .mcp.json registers the MCP server as "${mcpName}"\n`))
}

/** Scripts every CloudConfig project needs (framework `dev` is left alone). */
const CLOUDCONFIG_SCRIPTS: Record<string, string> = {
  'db:generate': 'cloudconfig db generate',
  'db:migrate': 'cloudconfig db migrate',
  'db:status': 'cloudconfig db status',
  doctor: 'cloudconfig doctor',
  mcp: 'cloudconfig mcp',
}

const STANDALONE_SCRIPTS: Record<string, string> = {
  dev: 'cloudconfig dev',
  start: 'node --experimental-strip-types server.ts',
  deploy: 'cloudconfig deploy',
  ...CLOUDCONFIG_SCRIPTS,
}

/**
 * Runtime dependencies every scaffolded project needs. The starter config turns
 * sign-in on, so better-auth is not optional here: without it the very first
 * `cloudconfig doctor` fails on a project the CLI just wrote.
 */
const RUNTIME_DEPS: Record<string, string> = {
  'better-auth': '^1.7.7',
  '@better-auth/passkey': '^1.7.7',
}

/** A Nuxt app mounts CloudConfig through the module. */
const NUXT_DEV_DEPS = { typescript: '^5.9.3', 'vue-tsc': '^3.0.0', wrangler: '^4.131.2' }

/** Local Node sqlite + migration tooling (optional peer + drizzle-kit CLI). */
const LOCAL_SQLITE_DEV_DEPS: Record<string, string> = {
  'better-sqlite3': '^12.0.0',
  'drizzle-kit': '^0.31.0',
}

const STANDALONE_DEV_DEPS = { ...LOCAL_SQLITE_DEV_DEPS, wrangler: '^4.131.2' }

type PackageJson = {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

function readPackageJson(pkgPath: string): PackageJson {
  return JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson
}

/** Fill missing keys only — never overwrite an existing script or dependency. */
function mergeMissing(
  target: Record<string, string> | undefined,
  defaults: Record<string, string>,
): { next: Record<string, string>; added: string[] } {
  const next = { ...target }
  const added: string[] = []
  for (const [key, value] of Object.entries(defaults)) {
    if (next[key] === undefined) {
      next[key] = value
      added.push(key)
    }
  }
  return { next, added }
}

function hasDep(pkg: PackageJson, name: string): boolean {
  return pkg.dependencies?.[name] !== undefined || pkg.devDependencies?.[name] !== undefined
}

/** Missing entries from `defaults`, given what the package already declares. */
function missingFrom(pkg: PackageJson, defaults: Record<string, string>): Record<string, string> {
  const missing: Record<string, string> = {}
  for (const [name, version] of Object.entries(defaults)) {
    if (!hasDep(pkg, name)) missing[name] = version
  }
  return missing
}

/**
 * Merge CloudConfig scripts + local sqlite tooling into an existing framework
 * package.json (Nuxt / Next / …). Skips keys that already exist.
 */
export function ensureFrameworkPackageJson(
  projectDir: string,
  framework?: Framework,
  dashboard = false,
): void {
  const pkgPath = join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) return

  const pkg = readPackageJson(pkgPath)
  const scripts = mergeMissing(
    pkg.scripts,
    framework === 'nuxt'
      ? {
          ...CLOUDCONFIG_SCRIPTS,
          dev: 'nuxt dev',
          build: 'nuxt build',
          typecheck: 'nuxt typecheck',
          deploy: 'cloudconfig deploy',
        }
      : CLOUDCONFIG_SCRIPTS,
  )
  const devDeps = mergeMissing(
    pkg.devDependencies,
    missingFrom(pkg, {
      ...LOCAL_SQLITE_DEV_DEPS,
      ...(framework === 'nuxt' ? NUXT_DEV_DEPS : {}),
    }),
  )
  // Nuxt mounts through the module, so it is a runtime dependency of the app.
  const runtimeDeps = mergeMissing(
    pkg.dependencies,
    missingFrom(
      pkg,
      framework === 'nuxt'
        ? {
            ...cloudconfigDependencies(projectDir),
            ...RUNTIME_DEPS,
            ...(dashboard ? NUXT_DASHBOARD_DEPENDENCIES : {}),
          }
        : RUNTIME_DEPS,
    ),
  )

  if (scripts.added.length === 0 && devDeps.added.length === 0 && runtimeDeps.added.length === 0) {
    return
  }

  writeFileSync(
    pkgPath,
    `${JSON.stringify(
      {
        ...pkg,
        scripts: scripts.next,
        ...(runtimeDeps.added.length > 0 ? { dependencies: runtimeDeps.next } : {}),
        ...(devDeps.added.length > 0 ? { devDependencies: devDeps.next } : {}),
      },
      null,
      2,
    )}\n`,
  )
  if (scripts.added.length > 0) report('package.json (scripts)', 'written')
  if (runtimeDeps.added.length > 0) report('package.json (dependencies)', 'written')
  if (devDeps.added.length > 0) report('package.json (devDependencies)', 'written')
}

function ensureStandalonePackageJson(projectDir: string): void {
  const pkgPath = join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      `${JSON.stringify(
        {
          name: 'my-cloudconfig-app',
          private: true,
          type: 'module',
          scripts: STANDALONE_SCRIPTS,
          dependencies: {
            '@hono/node-server': '^2.0.9',
            '@cloudconfig/core': cloudconfigDependencies(projectDir)['@cloudconfig/core'],
            ...RUNTIME_DEPS,
          },
          devDependencies: { ...STANDALONE_DEV_DEPS },
        },
        null,
        2,
      )}\n`,
    )
    report('package.json', 'written')
    return
  }
  // Existing package.json: fill missing scripts + local sqlite tooling the same
  // way Nuxt/Next init does — never overwrite keys the project already set.
  const pkg = readPackageJson(pkgPath)
  const scripts = mergeMissing(pkg.scripts, STANDALONE_SCRIPTS)
  const deps = mergeMissing(pkg.devDependencies, missingFrom(pkg, STANDALONE_DEV_DEPS))
  const runtimeDeps = mergeMissing(pkg.dependencies, missingFrom(pkg, RUNTIME_DEPS))

  if (scripts.added.length === 0 && deps.added.length === 0 && runtimeDeps.added.length === 0) {
    return
  }

  writeFileSync(
    pkgPath,
    `${JSON.stringify(
      {
        ...pkg,
        scripts: scripts.next,
        ...(runtimeDeps.added.length > 0 ? { dependencies: runtimeDeps.next } : {}),
        ...(deps.added.length > 0 ? { devDependencies: deps.next } : {}),
      },
      null,
      2,
    )}\n`,
  )
  if (scripts.added.length > 0) report('package.json (scripts)', 'written')
  if (runtimeDeps.added.length > 0) report('package.json (dependencies)', 'written')
  if (deps.added.length > 0) report('package.json (devDependencies)', 'written')
}
