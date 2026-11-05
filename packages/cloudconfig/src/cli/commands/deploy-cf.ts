/**
 * `cloudconfig deploy` for a project configured by cf's `cloudflare.config.ts`.
 *
 * cf owns the Worker definition: bindings, domains, routes and resource provisioning.
 * CloudConfig adds what cf does not do: it validates secrets before building,
 * preflights and applies D1 migrations after a successful build and before the
 * upload, and ships the secrets in the uploaded version.
 */
import { join } from 'node:path'
import pc from 'picocolors'
import { resolveDatabaseProvider } from '../../shared/database-provider.js'
import { deploySecretNames } from '../../shared/deploy-secrets.js'
import { resolveProjectConfig } from '../../shared/project-config.js'
import { agentDeployment, automationDeployment } from '../../shared/worker-exports.js'
import { preflightAndMigrate } from '../cloudflare/deploy-data.js'
import {
  buildSecretPlan,
  missingSecretsMessage,
  resolveSecretValues,
} from '../cloudflare/secrets.js'
import {
  BUILD_OUTPUT_WORKER_CONFIG,
  CLOUDFLARE_CONFIG_FILE,
  cfBuild,
  cfDeploy,
  cfRemoteD1,
  createD1Database,
  findD1DatabaseId,
  hasLocalCfBin,
  isCfAuthenticated,
  listCfSecrets,
  readBuiltWorker,
  type BuiltWorker,
} from '../cloudflare/cf-ops.js'
import { listLocalMigrationFiles } from '../cloudflare/migration-preflight.js'
import { detectPackageManager, installDevDepCommand } from '../package-manager.js'
import type { DeploymentRequest } from '../deployment/ports.js'

function fail(message: string): void {
  console.error(pc.red(message))
  process.exitCode = 1
}

/** Declarations the wrangler.jsonc path reconciles automatically but this path cannot yet. */
function unsupportedDeclaration(request: DeploymentRequest): string | undefined {
  const { config } = request
  const deploy = config.deploy ?? {}
  if (resolveDatabaseProvider(config) !== 'd1') {
    return 'A remote libSQL or Turso database'
  }
  if (agentDeployment(deploy) || automationDeployment(deploy) || deploy.workflows?.length) {
    return 'deploy.agent, deploy.automations and deploy.workflows'
  }
  if (deploy.turnstile) return 'deploy.turnstile'
  if (deploy.worker) return 'deploy.worker (set worker.name in cloudflare.config.ts)'
  return undefined
}

/** Built-config checks that would otherwise fail after the database is migrated. */
function builtWorkerProblem(
  request: DeploymentRequest,
  worker: BuiltWorker,
  secrets: string[],
): string | undefined {
  const { config } = request
  const { d1Binding } = resolveProjectConfig(config)
  if (worker.env[d1Binding]?.type !== 'd1') {
    return `${CLOUDFLARE_CONFIG_FILE} has no D1 binding named ${d1Binding}. Spread cloudflareBindings(config) from @cloudconfig/core/cloudflare into worker.env.`
  }
  const undeclared = secrets.filter((name) => worker.env[name]?.type !== 'secret')
  if (undeclared.length > 0) {
    return `cf uploads only declared secrets. Declare ${undeclared.join(', ')} with bindings.secret(), or spread cloudflareBindings(config).`
  }
  const { r2, r2Binding = 'BUCKET' } = config.deploy ?? {}
  if (r2 && worker.env[r2Binding]?.type !== 'r2') {
    return `deploy.r2 expects an R2 binding named ${r2Binding} in ${CLOUDFLARE_CONFIG_FILE}.`
  }
  const domain = config.deploy?.domain?.trim()
  if (domain && !worker.domains.includes(domain)) {
    return `deploy.domain is "${domain}". Add it to worker.domains in ${CLOUDFLARE_CONFIG_FILE}.`
  }
  return undefined
}

async function resolveDatabase(
  projectDir: string,
  binding: { id?: string; name?: string },
  dryRun: boolean,
): Promise<{ id: string } | { planned: string } | undefined> {
  if (binding.id) return { id: binding.id }
  if (!binding.name) {
    fail(`Give the D1 binding in ${CLOUDFLARE_CONFIG_FILE} a name or id.`)
    return undefined
  }
  const existing = await findD1DatabaseId(projectDir, binding.name)
  if (existing) return { id: existing }
  if (dryRun) {
    console.log(pc.dim(`Would create D1 database "${binding.name}".`))
    return { planned: binding.name }
  }
  // Created here, not by cf's deploy-time provisioning, so migrations run before the upload.
  console.log(pc.dim(`Creating D1 database "${binding.name}"…`))
  const id = await createD1Database(projectDir, binding.name)
  console.log(pc.green(`D1 database "${binding.name}" created.`))
  return { id }
}

export async function deployWithCf(request: DeploymentRequest): Promise<void> {
  const { projectDir, config, options } = request
  const dryRun = options.dryRun === true
  const { migrationsDir } = resolveProjectConfig(config)

  const unsupported = unsupportedDeclaration(request)
  if (unsupported) {
    fail(
      `${CLOUDFLARE_CONFIG_FILE} deploys do not support ${unsupported} yet. Use wrangler.jsonc for this project.`,
    )
    return
  }
  if (!hasLocalCfBin(projectDir)) {
    fail(
      `Cannot find the cf CLI required by ${CLOUDFLARE_CONFIG_FILE}.\n\n  Install: ${installDevDepCommand(detectPackageManager(projectDir), 'cf')}`,
    )
    return
  }
  if (!(await isCfAuthenticated(projectDir))) {
    fail('cf is not authenticated. Run `cf auth login` (or set CLOUDFLARE_API_TOKEN) and re-run.')
    return
  }

  const { required, optional } = deploySecretNames(config)
  const { values, sources } = resolveSecretValues([...required, ...optional], projectDir)
  const missingLocally = required.filter((name) => !values[name])

  if (options.skipBuild) {
    console.log(pc.dim('Skipping the build (--skip-build).'))
  } else {
    // cf invokes the framework build and writes the Build Output that deploy uploads.
    console.log(pc.dim('Building with cf…'))
    if ((await cfBuild(projectDir)) !== 0) {
      fail('Build failed — no Worker or database was changed.')
      return
    }
  }
  const worker = readBuiltWorker(projectDir)
  if (!worker) {
    fail(
      `No cf Build Output at ${BUILD_OUTPUT_WORKER_CONFIG}. Run \`cf build\` or omit --skip-build.`,
    )
    return
  }

  const wanted = [...required, ...optional.filter((name) => values[name])]
  const problem = builtWorkerProblem(request, worker, wanted)
  if (problem) {
    fail(problem)
    return
  }

  const remoteNames = missingLocally.length > 0 ? await listCfSecrets(projectDir, worker.name) : []
  const secretPlan = buildSecretPlan(wanted, values, remoteNames)
  if (secretPlan.missing.length > 0) {
    fail(missingSecretsMessage(secretPlan.missing))
    return
  }
  const fromEnv = secretPlan.toPush.filter((name) => sources[name] === 'env')
  if (fromEnv.length > 0) {
    console.log(pc.dim(`Secret(s) taken from the environment: ${fromEnv.join(', ')}`))
  }

  const { d1Binding } = resolveProjectConfig(config)
  const database = await resolveDatabase(projectDir, worker.env[d1Binding] ?? {}, dryRun)
  if (!database) return
  if ('planned' in database) {
    const files = listLocalMigrationFiles(join(projectDir, migrationsDir))
    console.log(pc.bold(`Would apply all ${files.length} migration(s) to "${database.planned}".`))
  } else {
    const migrate = await preflightAndMigrate(cfRemoteD1(projectDir, database.id, migrationsDir), {
      migrationsDir: join(projectDir, migrationsDir),
      force: options.force === true,
      dryRun,
    })
    if (!migrate.ok) return
  }

  if (dryRun) {
    console.log(pc.dim(`Would deploy Worker "${worker.name}" with cf.`))
    if (secretPlan.toPush.length > 0) {
      console.log(pc.dim(`Would upload secret(s): ${secretPlan.toPush.join(', ')}`))
    }
    return
  }

  console.log(pc.dim(`Deploying Worker "${worker.name}" with cf…`))
  const secrets: Record<string, string> = {}
  for (const name of secretPlan.toPush) secrets[name] = values[name] as string
  if ((await cfDeploy(projectDir, secrets)) !== 0) {
    fail(
      'cf deploy failed; pending migrations were already applied. See the output above, then re-run.',
    )
    return
  }
  if (secretPlan.toPush.length > 0) {
    console.log(pc.green(`Secrets deployed with the Worker: ${secretPlan.toPush.join(', ')}`))
  }
  console.log(pc.green('Deployed.'))
  for (const domain of worker.domains) {
    console.log(pc.green('Custom domain:'), pc.cyan(`https://${domain}`))
  }
}
