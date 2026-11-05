#!/usr/bin/env node
/**
 * The `cloudconfig` CLI. Thin commander program delegating to the command modules.
 */
import { Command } from 'commander'
import { resolve } from 'node:path'
import pc from 'picocolors'
import { authAdd, authEmail, authSecret, authStatus } from './commands/auth.js'
import { registerConnectCommands } from './commands/connect.js'
import { initCommand } from './commands/init.js'
import type { Framework } from './detect.js'
import { doctorCommand } from './commands/doctor.js'
import { devCommand } from './commands/dev.js'
import { mcpCommand } from './commands/mcp.js'
import { dbGenerate, dbMigrate, dbStatus } from './commands/db.js'
import { deployCommand } from './commands/deploy.js'
import { parseDevPort } from './dev-port.js'
import { formatCliError } from './format-error.js'
import { readCloudconfigPackage } from './package-info.js'
import { voidPrepareCommand } from './commands/void.js'

function cwd(): string {
  return process.cwd()
}

const TARGETS: Framework[] = ['nuxt', 'next', 'standalone']
const TEMPLATES = ['dashboard'] as const

/** Validate `--target`, so a typo fails loudly instead of scaffolding the wrong thing. */
function parseTarget(value: string | undefined): Framework | undefined {
  if (value === undefined) return undefined
  const target = TARGETS.find((t) => t === value)
  if (!target) {
    throw new Error(`Unknown --target "${value}". Expected one of: ${TARGETS.join(', ')}.`)
  }
  return target
}

function parseTemplate(value: string | undefined): 'dashboard' | undefined {
  if (value === undefined) return undefined
  if (value !== 'dashboard') {
    throw new Error(`Unknown --template "${value}". Expected: ${TEMPLATES.join(', ')}.`)
  }
  return value
}

export function createProgram(): Command {
  const program = new Command()
  program
    .name('cloudconfig')
    .description(
      'CloudConfig \u2014 one config file \u2192 a deployed backend on Cloudflare, Vercel or Azure.',
    )
    .version(readCloudconfigPackage().version)

  program
    .command('init [directory]')
    .description('scaffold cloud.config.ts and wire the framework mount file')
    .option(
      '-t, --target <target>',
      `force a target instead of detecting one (${TARGETS.join(', ')})`,
    )
    .option('--cloudflare', 'configure the Nuxt Worker build, assets, and Wrangler deployment')
    .option('--template <template>', 'scaffold a starter config (dashboard; includes UI for Nuxt)')
    .action(
      (
        directory: string | undefined,
        opts: { target?: string; cloudflare?: boolean; template?: string },
      ) => {
        const target = parseTarget(opts.target)
        const template = parseTemplate(opts.template)
        initCommand(resolve(cwd(), directory ?? '.'), {
          ...(target ? { target } : {}),
          ...(opts.cloudflare ? { cloudflare: true } : {}),
          ...(template ? { template } : {}),
        })
      },
    )

  program
    .command('dev')
    .description('run the standalone dev server (boot-migrate + serve + docs)')
    .option('-p, --port <port>', 'port', '3000')
    .option('--no-studio', 'disable local Drizzle Studio in Swagger UI')
    .action(async (opts: { port: string; studio: boolean }) => {
      await devCommand(cwd(), parseDevPort(opts.port), { studio: opts.studio })
    })

  program
    .command('mcp')
    .description('run the MCP server over stdio (schema + CRUD for coding agents)')
    .action(async () => {
      await mcpCommand(cwd())
    })

  program
    .command('doctor')
    .description('check that the project is ready to generate, migrate, and run')
    .action(async () => {
      await doctorCommand(cwd())
    })

  const voidCommands = program
    .command('void')
    .description('schema-first backend extension for Void')
  voidCommands
    .command('prepare')
    .description('export schema, migration mirror, environment declarations and a native API mount')
    .option('--framework', 'keep the existing framework API mount')
    .option(
      '--external-env',
      'compose the generated environment schema into an application-owned env.ts',
    )
    .action(async (options: { framework?: boolean; externalEnv?: boolean }) => {
      await voidPrepareCommand(cwd(), options)
    })

  const db = program.command('db').description('database & migration commands')
  db.command('generate')
    .description('diff the config schema and write a SQL migration (via drizzle-kit)')
    .action(async () => {
      await dbGenerate(cwd())
    })
  db.command('migrate')
    .description('apply migrations (local sqlite, or wrangler d1 in framework mode)')
    .option('--remote', 'apply to the remote D1 database', false)
    .action(async (opts: { remote: boolean }) => {
      await dbMigrate(cwd(), opts.remote)
    })
  db.command('status')
    .description('report pending migrations')
    .option(
      '--remote',
      'check the remote D1 database for pending migrations, drift and tamper',
      false,
    )
    .action(async (opts: { remote: boolean }) => {
      await dbStatus(cwd(), { remote: opts.remote })
    })

  const auth = program
    .command('auth')
    .description('sign-in: providers, credentials, and the session secret')

  auth
    .command('add')
    .description('enable a social provider and store its credentials')
    .argument('<provider>', 'provider id (google, github, microsoft, …)')
    .option(
      '--url <origin>',
      'development origin used for the redirect URI',
      'http://localhost:3000',
    )
    .option('--no-prompt', 'skip the credential prompts and just print the setup')
    .action(async (provider: string, opts: { url?: string; prompt?: boolean }) => {
      await authAdd(cwd(), provider, {
        ...(opts.url !== undefined ? { url: opts.url } : {}),
        ...(opts.prompt === false ? { noPrompt: true } : {}),
      })
    })

  auth
    .command('secret')
    .description('generate the session signing secret into the local env file')
    .option('--force', 'overwrite an existing secret (signs everyone out)', false)
    .action(async (opts: { force: boolean }) => {
      await authSecret(cwd(), { force: opts.force })
    })

  auth
    .command('email')
    .description('configure the DashboardStack / Cloudflare email service for verification codes')
    .option('--no-prompt', 'print the required environment variables')
    .action(async (opts: { prompt?: boolean }) => {
      await authEmail(cwd(), { noPrompt: opts.prompt === false })
    })

  auth
    .command('status')
    .description('report providers, missing credentials and redirect URIs')
    .option(
      '--url <origin>',
      'development origin used for the redirect URI',
      'http://localhost:3000',
    )
    .action(async (opts: { url?: string }) => {
      await authStatus(cwd(), opts.url !== undefined ? { url: opts.url } : {})
    })

  registerConnectCommands(program)

  program
    .command('deploy')
    .description('build, migrate and deploy to deploy.target (cloudflare, vercel or azure)')
    .option('--force', 'deploy despite blocking schema drift (unsafe)', false)
    .option('--skip-build', 'skip the package.json build script', false)
    .option('--dry-run', 'report what would happen without mutating anything', false)
    .action(async (opts: { force: boolean; skipBuild: boolean; dryRun: boolean }) => {
      await deployCommand(cwd(), {
        force: opts.force,
        skipBuild: opts.skipBuild,
        dryRun: opts.dryRun,
      })
    })

  return program
}

async function main(): Promise<void> {
  const program = createProgram()
  await program.parseAsync(process.argv)
}

main().catch((err: unknown) => {
  console.error(pc.red(formatCliError(err, cwd())))
  process.exitCode = 1
})
