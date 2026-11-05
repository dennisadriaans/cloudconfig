/**
 * `cloudconfig deploy` — validate, build, provision, preflight, migrate, deploy with secrets.
 *
 * Projects with cf's `cloudflare.config.ts` instead of a Wrangler config deploy
 * through `deploy-cf.ts`.
 *
 * Validate config, auth and secrets before building; optional Turnstile setup
 * supplies its public key to the build. D1/R2 provisioning and migrations only
 * follow a successful build, so failures cannot migrate ahead of the old code.
 * Secrets ship in the same Worker version, so it never runs without them.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pc from 'picocolors'
import { ensureD1, runPreflightAndMigrate } from '../cloudflare/deploy-data.js'
import { resolveDatabaseProvider } from '../../shared/database-provider.js'
import { dbGenerate } from './db.js'
import { detectPackageManager, installDevDepCommand, runScriptCommand } from '../package-manager.js'
import { resolveProjectConfig } from '../../shared/project-config.js'
import { deploySecretNames } from '../../shared/deploy-secrets.js'
import { isWranglerInstalled, missingWranglerMessage, wranglerConfigPath } from '../wrangler.js'
import { CLOUDFLARE_CONFIG_FILE, hasCloudflareConfig } from '../cloudflare/cf-ops.js'
import { runInherit } from '../cloudflare/exec.js'
import {
  createR2Bucket,
  deployWorker,
  extractWorkersUrl,
  isAuthenticated,
  isValidWorkerName,
  listSecrets,
  putSecretsBulk,
} from '../cloudflare/wrangler-ops.js'
import { listLocalMigrationFiles, loadLatestSnapshot } from '../cloudflare/migration-preflight.js'
import {
  addCustomDomainRoute,
  addR2Binding,
  customDomainSnippet,
  defaultResourceName,
  invalidCustomDomainMessage,
  isPlaceholderDatabaseId,
  isValidCustomDomain,
  readCustomDomains,
  readD1Binding,
  readMigrationsDir,
  readR2Binding,
  readWranglerFile,
  resolveDeployTarget,
  writeWranglerFile,
  type WranglerFile,
} from '../cloudflare/wrangler-config.js'
import {
  buildSecretPlan,
  missingSecretsMessage,
  resolveSecretValues,
} from '../cloudflare/secrets.js'
import type { DeployConfig } from '../../dsl/model-config.js'
import { ensureTurnstile, planTurnstile, TURNSTILE_SECRET } from '../cloudflare/turnstile.js'
import { reconcileAgentBindings, assertWorkerExports } from '../cloudflare/agent-bindings.js'
import {
  agentDeployment,
  automationDeployment,
  workerExports,
} from '../../shared/worker-exports.js'
import { parse } from 'jsonc-parser'
import { prepareDataDeployment } from '../deployment/data.js'
import type { DeploymentRequest } from '../deployment/ports.js'
import { prepareAutomationDeployment } from '../deployment/automations.js'

function fail(message: string): void {
  console.error(pc.red(message))
  process.exitCode = 1
}

/** What already changed remotely, so a later failure can say so honestly. */
interface Progress {
  createdD1: boolean
  createdR2: boolean
  appliedMigrations: number
}

function progressNote(progress: Progress): string {
  const done: string[] = []
  if (progress.createdD1) done.push('the D1 database was created')
  if (progress.createdR2) done.push('the R2 bucket was created')
  if (progress.appliedMigrations > 0) {
    done.push(`${progress.appliedMigrations} migration(s) were applied to remote D1`)
  }
  if (done.length === 0) return 'No D1/R2 resources or migrations were changed.'
  return `Already done before this failure: ${done.join(', ')}.`
}

export async function deployCloudflare(request: DeploymentRequest): Promise<void> {
  const { projectDir, config, options: opts } = request
  const dryRun = opts.dryRun === true
  const deploy: DeployConfig = config.deploy ?? {}
  const automations = prepareAutomationDeployment(request)
  const resolved = resolveProjectConfig(config)
  const migrationsDirRel = resolved.migrationsDir
  const migrationsDirAbs = join(projectDir, migrationsDirRel)

  if (
    Object.keys(config.models).length === 0 &&
    !config.auth &&
    listLocalMigrationFiles(migrationsDirAbs).length === 0
  ) {
    fail(
      'No migrations found for the external schema. Generate SQL migrations and Drizzle snapshots with your app’s schema tooling, then set db.migrationsDir to their directory.',
    )
    return
  }

  if (listLocalMigrationFiles(migrationsDirAbs).length === 0 && !dryRun) {
    console.log(pc.dim('No migrations found; generating the initial migration…'))
    await dbGenerate(projectDir)
    if (process.exitCode || listLocalMigrationFiles(migrationsDirAbs).length === 0) return
  }
  if (listLocalMigrationFiles(migrationsDirAbs).length === 0) {
    fail('No migrations found. Run `cloudconfig db generate` before a dry run.')
    return
  }
  if (!loadLatestSnapshot(migrationsDirAbs)) {
    fail(
      'No migration snapshot found. Restore migration metadata or run `cloudconfig db generate` before deploying.',
    )
    return
  }

  if (hasCloudflareConfig(projectDir)) {
    if (wranglerConfigPath(projectDir)) {
      fail(
        `Found both ${CLOUDFLARE_CONFIG_FILE} and a Wrangler config. Keep one: cloudconfig deploy uses cf for ${CLOUDFLARE_CONFIG_FILE} and wrangler otherwise.`,
      )
      return
    }
    const { deployWithCf } = await import('./deploy-cf.js')
    await deployWithCf(request)
    return
  }

  const remoteData =
    resolveDatabaseProvider(config) === 'd1' ? undefined : prepareDataDeployment(request)

  let file = readWranglerFile(projectDir)
  if (!file) {
    fail(
      [
        'No wrangler config found — cloudconfig deploy targets Cloudflare Workers.',
        '',
        '  Create wrangler.jsonc with at least a "name" and "main", then re-run.',
      ].join('\n'),
    )
    return
  }

  const existingD1 = readD1Binding(file.text)
  try {
    for (const entry of workerExports(deploy)) {
      if (!existsSync(join(projectDir, entry.entry))) {
        throw new Error(`Worker entry not found: ${entry.entry}`)
      }
    }
    if (agentDeployment(deploy) || automationDeployment(deploy) || deploy.workflows?.length) {
      if (file.format !== 'json') {
        throw new Error('Agent and Workflow deployment declarations require wrangler.jsonc.')
      }
      const updated = reconcileAgentBindings(file.text, deploy)
      if (updated !== file.text) {
        if (!dryRun) writeWranglerFile(file, updated)
        console.log(
          pc.dim(
            dryRun
              ? 'Would reconcile Agent/Workflow bindings and SQLite migrations.'
              : 'Reconciled Agent/Workflow bindings and SQLite migrations.',
          ),
        )
        file = { ...file, text: updated }
      }
    }
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : 'Invalid Worker declarations.')
    return
  }
  if (!remoteData && existingD1 && existingD1.binding !== resolved.d1Binding) {
    fail(
      `Wrangler binds D1 as ${existingD1.binding}, but cloud.config.ts expects ${resolved.d1Binding}. Make these binding names agree before deploying.`,
    )
    return
  }
  if (
    !remoteData &&
    existingD1 &&
    (readMigrationsDir(file.text) ?? 'migrations') !== migrationsDirRel
  ) {
    fail(
      `Wrangler migrations_dir must match db.migrationsDir (${migrationsDirRel}) before deploying.`,
    )
    return
  }
  const existingR2 = readR2Binding(file.text)
  if (
    deploy.r2 &&
    existingR2 &&
    (existingR2.binding !== (deploy.r2Binding ?? 'BUCKET') || existingR2.bucketName !== deploy.r2)
  ) {
    fail(
      'The Wrangler R2 binding differs from deploy.r2/r2Binding. Resolve the mismatch before deploying; no bucket was created.',
    )
    return
  }
  if (
    file.format === 'toml' &&
    ((!remoteData && (!existingD1 || isPlaceholderDatabaseId(existingD1.databaseId))) ||
      (deploy.r2 && !existingR2))
  ) {
    fail(
      'Automatic provisioning requires wrangler.jsonc. Convert the TOML config or configure its real D1/R2 bindings before deploying; nothing was created.',
    )
    return
  }

  // The hostname is checked before anything remote happens: a typo here would
  // otherwise surface as a wrangler API error after the database is migrated.
  const domain = deploy.domain?.trim()
  if (domain !== undefined && !isValidCustomDomain(domain)) {
    fail(invalidCustomDomainMessage(deploy.domain as string))
    return
  }
  if (domain && file.format === 'toml' && !readCustomDomains(file.text).includes(domain)) {
    fail(
      [
        `deploy.domain is set to "${domain}", but wrangler.toml is not rewritten automatically.`,
        '',
        '  Add the equivalent of:',
        '',
        customDomainSnippet(domain),
      ].join('\n'),
    )
    return
  }

  if (!isWranglerInstalled(projectDir)) {
    fail(missingWranglerMessage(installDevDepCommand(detectPackageManager(projectDir), 'wrangler')))
    return
  }

  if (!(await isAuthenticated(projectDir))) {
    fail(
      'wrangler is not authenticated. Run `wrangler login` (or set CLOUDFLARE_API_TOKEN) and re-run.',
    )
    return
  }

  // One resolved target for every remote call: deploy, secret list, secret push.
  const target = resolveDeployTarget(
    file.text,
    deploy.worker ?? deploy.name,
    defaultResourceName(projectDir, undefined, 'app'),
  )
  if (!isValidWorkerName(target.workerName)) {
    fail(`"${target.workerName}" is not a valid Worker name (letters, digits, - and _ only).`)
    return
  }
  if (target.overridden) {
    console.log(
      pc.dim(`deploy.worker overrides the wrangler name — deploying as "${target.workerName}".`),
    )
  }

  // ─── validate secrets, prepare optional Turnstile, then build ───────────────

  const turnstile = planTurnstile(projectDir, file, deploy)
  const secretNames = deploySecretNames(config)
  const declared = [
    ...new Set([
      ...secretNames.required,
      ...Object.keys(remoteData?.env ?? {}),
      ...Object.keys(automations?.env ?? {}),
    ]),
  ].filter((key) => !turnstile || key !== TURNSTILE_SECRET)
  const optional = secretNames.optional
  const { values: secretValues, sources: secretSources } = resolveSecretValues(
    [...declared, ...optional],
    projectDir,
  )
  Object.assign(secretValues, remoteData?.env)
  Object.assign(secretValues, automations?.env)
  const wanted = [...new Set([...declared, ...optional.filter((key) => secretValues[key])])]
  const remoteSecretNames =
    wanted.length === 0 ? [] : await listSecrets(projectDir, target.workerName)
  const secretPlan = buildSecretPlan(wanted, secretValues, remoteSecretNames)
  if (secretPlan.missing.length > 0) {
    fail(missingSecretsMessage(secretPlan.missing))
    return
  }
  const fromEnv = secretPlan.toPush.filter((key) => secretSources[key] === 'env')
  if (fromEnv.length > 0) {
    console.log(pc.dim(`Secret(s) taken from the environment: ${fromEnv.join(', ')}`))
  }

  let buildEnv: Record<string, string> = {}
  if (turnstile) {
    // The public key must be available before prerendering / frontend bundling.
    const result = await ensureTurnstile(
      { projectDir, file, workerName: target.workerName },
      turnstile,
      dryRun,
    )
    buildEnv = result.buildEnv
    if (result.secret) secretValues[TURNSTILE_SECRET] = result.secret
    secretPlan.toPush.push(TURNSTILE_SECRET)
    file = readWranglerFile(projectDir) ?? file
  }

  if (opts.skipBuild) {
    console.log(pc.dim('Skipping the build (--skip-build).'))
  } else if (dryRun) {
    if (buildScriptName(projectDir)) console.log(pc.dim('Would run the project build script.'))
  } else if (!(await runBuild(projectDir, buildEnv))) {
    return
  }
  if (!dryRun && workerExports(deploy).length) {
    const main = (parse(file.text) as { main?: string }).main
    const path = main ? join(projectDir, main) : ''
    if (!path || !existsSync(path)) {
      fail('Build the Worker entry before deploying Agent classes.')
      return
    }
    try {
      assertWorkerExports(readFileSync(path, 'utf8'), deploy)
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : 'Invalid built Worker exports.')
      return
    }
  }

  // ─── database and storage mutations only after a successful build ───────────

  const progress: Progress = { createdD1: false, createdR2: false, appliedMigrations: 0 }

  const d1 = remoteData
    ? { file, databaseName: 'libsql', created: false, planned: false }
    : await ensureD1(projectDir, file, {
        dbName: deploy.d1 ?? resolved.dbName ?? defaultResourceName(projectDir, file.text, 'db'),
        binding: resolved.d1Binding,
        migrationsDir: migrationsDirRel,
        dryRun,
      })
  if (!d1) return
  progress.createdD1 = d1.created

  if (deploy.r2) {
    const r2 = await ensureR2(projectDir, d1.file, deploy, dryRun)
    if (!r2.ok) return
    progress.createdR2 = r2.created
  }

  // Re-read: ensureD1 / ensureR2 may each have rewritten the file on disk, and
  // the route splice has to land on the current text, not a stale copy.
  if (domain) ensureCustomDomain(readWranglerFile(projectDir) ?? d1.file, domain, dryRun)

  // A first deploy has no database to read yet, so a dry run plans against the
  // local migrations instead of preflighting a database it just said it would
  // create.
  if (remoteData) {
    if (dryRun) console.log(pc.dim('Would preflight and migrate the shared libSQL database.'))
    else await remoteData.migrate()
  } else if (dryRun && d1.planned) {
    reportFirstDeployPlan(migrationsDirAbs, d1.databaseName)
  } else {
    const migrate = await runPreflightAndMigrate(projectDir, {
      dbName: d1.databaseName,
      migrationsDir: migrationsDirAbs,
      force: opts.force === true,
      dryRun,
    })
    progress.appliedMigrations = migrate.applied
    if (!migrate.ok) return
  }

  if (dryRun) {
    console.log(pc.dim(`Would deploy Worker "${target.workerName}".`))
    if (secretPlan.toPush.length > 0) {
      console.log(pc.dim(`Would sync secret(s): ${secretPlan.toPush.join(', ')}`))
    }
    if (automations) {
      console.log(
        pc.dim(
          `Would synchronize ${automations.count} static automation schedule(s) after publication.`,
        ),
      )
    }
    return
  }

  console.log(pc.dim(`Deploying Worker "${target.workerName}"…`))
  const payload: Record<string, string> = {}
  for (const key of secretPlan.toPush) payload[key] = secretValues[key] as string
  const result = await deployWorker(projectDir, target.workerName, payload)
  if (result.code !== 0) {
    fail(`wrangler deploy failed. See the output above.\n${progressNote(progress)}`)
    return
  }

  if (result.secretsUploaded) {
    console.log(pc.green(`Secrets deployed with the Worker: ${secretPlan.toPush.join(', ')}`))
  } else if (secretPlan.toPush.length > 0) {
    console.log(pc.dim(`Syncing ${secretPlan.toPush.length} secret(s)…`))
    try {
      await putSecretsBulk(projectDir, target.workerName, payload)
      console.log(pc.green(`Secrets synced: ${secretPlan.toPush.join(', ')}`))
    } catch (err) {
      fail(
        `The Worker is deployed, but syncing secrets failed — it is running without them:\n${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return
    }
  }

  const url = extractWorkersUrl(`${result.stdout}\n${result.stderr}`)
  if (automations) {
    const origin = domain ? `https://${domain}` : url
    if (!origin) {
      throw new Error(
        'The Worker was published but its URL was not reported. Synchronize automation schedules after checking the Worker deployment.',
      )
    }
    await automations.configure(origin)
  }
  console.log(pc.green('Deployed.'), url ? pc.cyan(url) : '')
  if (domain) {
    console.log(pc.green('Custom domain:'), pc.cyan(`https://${domain}`))
    console.log(
      pc.dim(
        '  DNS and the certificate are issued by Cloudflare; the first request may 5xx briefly.',
      ),
    )
    console.log(
      pc.dim(
        `  Sign-in: point the app URL (BETTER_AUTH_URL) at https://${domain} so redirect URIs match.`,
      ),
    )
  }
}

/**
 * Put `deploy.domain` in the wrangler config as a custom-domain route, so the
 * deploy that follows publishes the Worker on that hostname.
 *
 * Idempotent, and never a hard failure: a route the config already declares is
 * left exactly as written (it may carry zone_id or other keys we would drop),
 * and a config we cannot splice is reported as a snippet to paste rather than
 * stopping a deploy whose database work is already done.
 */
function ensureCustomDomain(file: WranglerFile, domain: string, dryRun: boolean): void {
  if (readCustomDomains(file.text).includes(domain)) return

  if (dryRun) {
    console.log(pc.dim(`Would route "${domain}" to the Worker as a custom domain.`))
    return
  }

  if (file.format === 'toml') {
    console.log(
      pc.yellow(
        `wrangler.toml is not rewritten automatically — add:\n${customDomainSnippet(domain)}`,
      ),
    )
    return
  }

  writeWranglerFile(file, addCustomDomainRoute(file.text, domain))
  console.log(pc.green(`Custom domain "${domain}" added to ${file.path.split('/').pop()}.`))
}

async function ensureR2(
  projectDir: string,
  file: WranglerFile,
  deploy: DeployConfig,
  dryRun: boolean,
): Promise<{ ok: boolean; created: boolean }> {
  const bucketName = deploy.r2 as string
  const binding = deploy.r2Binding ?? 'BUCKET'
  const existing = readR2Binding(file.text)

  if (dryRun) {
    console.log(pc.dim(`Would ensure R2 bucket "${bucketName}" bound as ${binding}.`))
    return { ok: true, created: false }
  }

  const result = await createR2Bucket(projectDir, bucketName)
  if (!result.ok) {
    fail(`Could not create R2 bucket "${bucketName}":\n${result.detail}`)
    return { ok: false, created: false }
  }
  console.log(
    pc.green(
      result.existed
        ? `R2 bucket "${bucketName}" already exists.`
        : `R2 bucket "${bucketName}" created.`,
    ),
  )

  if (existing) return { ok: true, created: !result.existed }
  if (file.format === 'toml') {
    fail(
      `Bucket "${bucketName}" exists, but wrangler.toml is not rewritten automatically — add an r2_buckets binding named ${binding}.`,
    )
    return { ok: false, created: !result.existed }
  }
  writeWranglerFile(file, addR2Binding(file.text, { binding, bucketName }))
  console.log(pc.green(`R2 bucket bound as ${binding}.`))
  return { ok: true, created: !result.existed }
}

/** The plan for a database that does not exist yet: create it, apply everything. */
function reportFirstDeployPlan(migrationsDir: string, dbName: string): void {
  const files = listLocalMigrationFiles(migrationsDir)
  console.log(pc.dim(`Preflight skipped: "${dbName}" does not exist yet.`))
  if (files.length === 0) {
    console.log(
      pc.yellow('No migrations on disk — run `cloudconfig db generate` before deploying.'),
    )
    return
  }
  console.log(pc.bold(`Would apply all ${files.length} migration(s):`))
  console.log(files.map((f) => `  ${pc.green('+')} ${f}`).join('\n'))
}

function buildScriptName(projectDir: string): string | undefined {
  const pkgPath = join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) return undefined
  try {
    const scripts = (
      JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> }
    ).scripts
    return typeof scripts?.['build'] === 'string' ? 'build' : undefined
  } catch {
    return undefined
  }
}

async function runBuild(projectDir: string, env: Record<string, string>): Promise<boolean> {
  if (!buildScriptName(projectDir)) return true

  const [command, ...args] = runScriptCommand(detectPackageManager(projectDir), 'build').split(' ')
  console.log(pc.dim('Building…'))
  const code = await runInherit(command as string, args, { cwd: projectDir, env })
  if (code !== 0) {
    fail(
      'Build failed — no Worker or database was changed. Any Turnstile widget prepared for the build is retained for the next deploy.',
    )
    return false
  }
  return true
}
