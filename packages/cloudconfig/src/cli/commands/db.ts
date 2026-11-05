/**
 * `cloudconfig db generate | migrate | status` — the migration commands.
 *
 * - generate: writes the drizzle-kit shim, then shells out to drizzle-kit.
 * - migrate:  applies committed SQL to the local db (standalone, or framework
 *             mode without wrangler.toml) or via wrangler (framework + D1).
 * - status:   reports pending local migrations, or with `--remote` runs the same
 *             preflight `cloudconfig deploy` uses (pending, drift, tamper).
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import pc from 'picocolors'
import { loadConfig } from '../config-load.js'
import {
  applyLocalMigrations,
  listMigrationSqlFiles,
  listPendingLocalMigrations,
  NO_MIGRATIONS_HINT,
} from '../migrate-local.js'
import { detectFramework } from '../detect.js'
import {
  drizzleKitGenerateFailedMessage,
  findDrizzleKitCli,
  missingDrizzleKitMessage,
} from '../drizzle-kit.js'
import { detectPackageManager, installDevDepCommand } from '../package-manager.js'
import { migrationsDirFor, writeShim } from '../shim.js'
import {
  hasD1Binding,
  hasWranglerConfig,
  isWranglerInstalled,
  missingWranglerMessage,
  wranglerMigrateFailedMessage,
} from '../wrangler.js'
import { withLocalBin } from '../local-bin.js'
import { buildMigrationPlan, planBlocks, planWarns } from '../cloudflare/migration-preflight.js'
import { renderPendingList, renderReport, summarizePlan } from '../cloudflare/migration-report.js'
import { cloudflarePreflightDeps } from '../cloudflare/wrangler-ops.js'
import { readD1Binding, readWranglerFile } from '../cloudflare/wrangler-config.js'
import { prepareDatabaseDeployment } from '../deployment/data.js'
import { resolveDeploymentTarget } from '../../shared/deployment-target.js'
import { resolveProjectConfig } from '../../shared/project-config.js'
import { resolveDatabaseProvider } from '../../shared/database-provider.js'

function betterSqlite3InstallCommand(projectDir: string): string {
  return installDevDepCommand(detectPackageManager(projectDir), 'better-sqlite3')
}

function drizzleKitInstallCommand(projectDir: string): string {
  return installDevDepCommand(detectPackageManager(projectDir), 'drizzle-kit')
}

function wranglerInstallCommand(projectDir: string): string {
  return installDevDepCommand(detectPackageManager(projectDir), 'wrangler')
}

export async function dbGenerate(projectDir: string): Promise<void> {
  const { path, config } = await loadConfig(projectDir)
  const migrationsDir = migrationsDirFor(config)
  const shim = writeShim(projectDir, path, config, migrationsDir)

  const drizzleKitCli = findDrizzleKitCli(projectDir)
  if (!drizzleKitCli) {
    console.error(pc.red(missingDrizzleKitMessage(drizzleKitInstallCommand(projectDir))))
    process.exitCode = 1
    return
  }

  console.log(pc.dim('Generating SQL migration via drizzle-kit…'))
  try {
    // Use the CLI's own Node, including on Windows where .cmd shims cannot be
    // launched with execFileSync and on machines with multiple Node versions.
    execFileSync(
      process.execPath,
      [drizzleKitCli, 'generate', '--config', shim.drizzleConfigPath],
      {
        cwd: projectDir,
        stdio: 'inherit',
        env: withLocalBin(projectDir),
      },
    )
  } catch (error) {
    console.error(pc.red(drizzleKitGenerateFailedMessage(error)))
    process.exitCode = 1
  }
}

function applyLocal(projectDir: string, migrationsDir: string, localDbPath: string): void {
  const result = applyLocalMigrations(join(projectDir, localDbPath), migrationsDir, {
    installCommand: betterSqlite3InstallCommand(projectDir),
  })
  if (result.onDisk === 0) {
    console.log(pc.yellow(NO_MIGRATIONS_HINT))
    process.exitCode = 1
    return
  }
  if (result.applied.length === 0) console.log(pc.dim('No pending migrations.'))
  else {
    console.log(
      pc.green(`Applied ${result.applied.length} migration(s):`),
      result.applied.join(', '),
    )
  }
}

export async function dbMigrate(projectDir: string, remote: boolean): Promise<void> {
  const { config } = await loadConfig(projectDir)
  const resolved = resolveProjectConfig(config)
  const migrationsDir = join(projectDir, resolved.migrationsDir)
  const framework = detectFramework(projectDir)
  if (remote && resolveDatabaseProvider(config) !== 'd1') {
    await prepareDatabaseDeployment({
      projectDir,
      configPath: '',
      config,
      framework,
      target: resolveDeploymentTarget(config.deploy?.target),
      name: config.deploy?.name ?? 'app',
      options: {},
    }).migrate()
    return
  }

  if (remote && !hasD1Binding(projectDir)) {
    console.error(
      pc.red(
        'No D1 binding configured. Configure Cloudflare before using --remote; the local database was not changed.',
      ),
    )
    process.exitCode = 1
    return
  }

  if (
    !remote &&
    (framework === 'standalone' || framework === 'nuxt' || !hasWranglerConfig(projectDir))
  ) {
    if (framework !== 'standalone') {
      console.log(pc.dim('Applying migrations to local SQLite…'))
    }
    applyLocal(projectDir, migrationsDir, resolved.localDbPath)
    return
  }

  if (!isWranglerInstalled(projectDir)) {
    console.error(pc.red(missingWranglerMessage(wranglerInstallCommand(projectDir))))
    process.exitCode = 1
    return
  }

  const flag = remote ? '--remote' : '--local'
  console.log(pc.dim(`Applying migrations via wrangler (${flag})…`))
  try {
    execFileSync('wrangler', ['d1', 'migrations', 'apply', resolved.d1Binding, flag], {
      cwd: projectDir,
      stdio: 'inherit',
      env: withLocalBin(projectDir),
    })
  } catch {
    console.error(pc.red(wranglerMigrateFailedMessage()))
    process.exitCode = 1
  }
}

export interface DbStatusOptions {
  remote?: boolean
}

export async function dbStatus(projectDir: string, opts: DbStatusOptions = {}): Promise<void> {
  const { config } = await loadConfig(projectDir, { allowExternalSchema: opts.remote === true })
  const resolved = resolveProjectConfig(config)
  const migrationsDir = join(projectDir, resolved.migrationsDir)
  const files = listMigrationSqlFiles(migrationsDir)

  if (opts.remote) {
    if (resolveDatabaseProvider(config) !== 'd1') {
      await prepareDatabaseDeployment({
        projectDir,
        configPath: '',
        config,
        framework: detectFramework(projectDir),
        target: resolveDeploymentTarget(config.deploy?.target),
        name: config.deploy?.name ?? 'app',
        options: { dryRun: true },
      }).migrate()
      return
    }
    if (!hasD1Binding(projectDir)) {
      console.error(pc.red('No D1 binding configured. Configure Cloudflare before using --remote.'))
      process.exitCode = 1
      return
    }
    if (!isWranglerInstalled(projectDir)) {
      console.error(pc.red(missingWranglerMessage(wranglerInstallCommand(projectDir))))
      process.exitCode = 1
      return
    }
    await reportRemoteStatus(projectDir, migrationsDir, resolved.d1Binding)
    return
  }

  if (files.length === 0) {
    console.log(pc.yellow(NO_MIGRATIONS_HINT))
    return
  }

  const framework = detectFramework(projectDir)
  if (framework === 'standalone' || framework === 'nuxt' || !hasWranglerConfig(projectDir)) {
    const pendingLocal = listPendingLocalMigrations(join(projectDir, resolved.localDbPath), files, {
      installCommand: betterSqlite3InstallCommand(projectDir),
    })
    console.log(pc.bold(`${files.length} migration(s) on disk.`))
    if (pendingLocal.length === 0) console.log(pc.green('Local database is up to date.'))
    else console.log(pc.yellow(`Pending locally: ${pendingLocal.join(', ')}`))
    return
  }

  console.log(pc.bold(`${files.length} migration(s) on disk.`))

  console.log(
    pc.dim('Add --remote to check the deployed D1 for pending migrations and schema drift.'),
  )
}

/** The same read-only preflight `cloudconfig deploy` runs, without the mutation step. */
async function reportRemoteStatus(
  projectDir: string,
  migrationsDir: string,
  binding: string,
): Promise<void> {
  const file = readWranglerFile(projectDir)
  const dbName = file ? (readD1Binding(file.text)?.databaseName ?? '') : ''
  if (!dbName) {
    console.error(
      pc.red('No d1_databases binding with a database_name — nothing to check remotely.'),
    )
    process.exitCode = 1
    return
  }
  if (file && readD1Binding(file.text)?.binding !== binding) {
    console.error(
      pc.red(
        `The configured D1 binding does not match db.binding (${binding}). Resolve the mismatch before checking remote status.`,
      ),
    )
    process.exitCode = 1
    return
  }

  try {
    const plan = await buildMigrationPlan(
      migrationsDir,
      cloudflarePreflightDeps(projectDir, dbName),
    )
    console.log(pc.bold(`Remote "${dbName}": ${summarizePlan(plan)}.`))
    if (plan.pending.length > 0) console.log(renderPendingList(plan))
    if (planBlocks(plan) || planWarns(plan)) console.log(renderReport(plan))
    // Drift is a real production problem: report it with a failing exit code so
    // a CI status check can gate on it.
    if (planBlocks(plan)) process.exitCode = 1
  } catch (err) {
    console.error(
      pc.red(`Remote status check failed:\n${err instanceof Error ? err.message : String(err)}`),
    )
    process.exitCode = 1
  }
}
