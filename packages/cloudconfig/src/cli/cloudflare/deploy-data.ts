import pc from 'picocolors'
import {
  provisionD1Database,
  cloudflarePreflightDeps,
  applyRemoteMigrations,
} from './wrangler-ops.js'
import {
  readD1Binding,
  isPlaceholderDatabaseId,
  bindingSnippet,
  setDatabaseId,
  addD1Binding,
  writeWranglerFile,
  type WranglerFile,
} from './wrangler-config.js'
import {
  buildMigrationPlan,
  planBlocks,
  planWarns,
  verifyTargetSchema,
  type PreflightDeps,
} from './migration-preflight.js'
import {
  renderReport,
  renderPendingList,
  renderTargetDrift,
  summarizePlan,
} from './migration-report.js'

function fail(message: string): void {
  console.error(pc.red(message))
  process.exitCode = 1
}

interface EnsuredD1 {
  file: WranglerFile
  databaseName: string
  /** The database was created by this run. */
  created: boolean
  /** A dry run would have created it: there is nothing remote to inspect. */
  planned: boolean
}

/** Create the D1 database when the config has no binding or a placeholder id. */
export async function ensureD1(
  projectDir: string,
  file: WranglerFile,
  opts: { dbName: string; binding: string; migrationsDir: string; dryRun: boolean },
): Promise<EnsuredD1 | undefined> {
  const existing = readD1Binding(file.text)
  if (existing && !isPlaceholderDatabaseId(existing.databaseId)) {
    return {
      file,
      databaseName: existing.databaseName || opts.dbName,
      created: false,
      planned: false,
    }
  }

  const dbName = existing?.databaseName || opts.dbName
  if (opts.dryRun) {
    console.log(pc.dim(`Would create D1 database "${dbName}" and bind it as ${opts.binding}.`))
    return { file, databaseName: dbName, created: false, planned: true }
  }

  console.log(pc.dim(`Creating D1 database "${dbName}"…`))
  const { id, detail } = await provisionD1Database(projectDir, dbName)
  if (!id) {
    // Never write a placeholder: wrangler deploy then hard-fails with API 10021.
    fail(
      [
        `Could not resolve a database_id for "${dbName}".`,
        detail ? pc.dim(detail.split('\n').slice(-8).join('\n')) : '',
        '',
        '  Create it in the Cloudflare dashboard (Workers & Pages → D1), then add:',
        '',
        bindingSnippet({
          binding: opts.binding,
          databaseName: dbName,
          databaseId: '<paste the Database ID>',
          migrationsDir: opts.migrationsDir,
        }),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    return undefined
  }

  if (file.format === 'toml') {
    fail(
      [
        `Created D1 database "${dbName}" (${id}), but wrangler.toml is not rewritten automatically.`,
        '',
        '  Add the equivalent of:',
        '',
        bindingSnippet({
          binding: opts.binding,
          databaseName: dbName,
          databaseId: id,
          migrationsDir: opts.migrationsDir,
        }),
      ].join('\n'),
    )
    return undefined
  }

  const text = existing
    ? setDatabaseId(file.text, id)
    : addD1Binding(file.text, {
        binding: opts.binding,
        databaseName: dbName,
        databaseId: id,
        migrationsDir: opts.migrationsDir,
      })
  writeWranglerFile(file, text)
  console.log(pc.green(`D1 database "${dbName}" bound as ${opts.binding}.`))
  return { file: { ...file, text }, databaseName: dbName, created: true, planned: false }
}

export interface MigrateOutcome {
  ok: boolean
  applied: number
}

/** A remote D1 database: reads for the preflight and the CLI call that migrates it. */
export interface RemoteD1 {
  deps: PreflightDeps
  /** Apply pending migrations; resolves to the CLI's exit code. */
  apply: () => Promise<number>
}

export function runPreflightAndMigrate(
  projectDir: string,
  opts: { dbName: string; migrationsDir: string; force: boolean; dryRun: boolean },
): Promise<MigrateOutcome> {
  return preflightAndMigrate(
    {
      deps: cloudflarePreflightDeps(projectDir, opts.dbName),
      apply: () => applyRemoteMigrations(projectDir, opts.dbName),
    },
    opts,
  )
}

/** Block destructive or tampered plans, apply the rest, then verify the remote schema. */
export async function preflightAndMigrate(
  { deps, apply }: RemoteD1,
  opts: { migrationsDir: string; force: boolean; dryRun: boolean },
): Promise<MigrateOutcome> {
  console.log(pc.dim('Checking remote database…'))
  let plan
  try {
    plan = await buildMigrationPlan(opts.migrationsDir, deps)
  } catch (err) {
    fail(`Migration preflight failed:\n${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, applied: 0 }
  }

  console.log(pc.dim(`Preflight: ${summarizePlan(plan)}.`))

  if (planBlocks(plan) && !opts.force) {
    console.error(renderReport(plan))
    process.exitCode = 1
    return { ok: false, applied: 0 }
  }
  if (planWarns(plan) || (planBlocks(plan) && opts.force)) console.warn(renderReport(plan))

  if (opts.dryRun) {
    console.log(pc.bold('Pending migrations:'))
    console.log(renderPendingList(plan))
    return { ok: true, applied: 0 }
  }

  if (plan.pending.length === 0) return { ok: true, applied: 0 }

  console.log(pc.dim(`Applying ${plan.pending.length} migration(s) to remote D1…`))
  const code = await apply()
  if (code !== 0) {
    fail(
      'Remote migration failed — nothing was deployed, and the database may be\npartially migrated. Fix the migration and re-run.',
    )
    return { ok: false, applied: 0 }
  }

  // The migrations ran; the app is deployed against the schema they were meant
  // to produce, so verify that is what the database actually has now.
  let verify
  try {
    verify = await verifyTargetSchema(opts.migrationsDir, deps)
  } catch (err) {
    fail(
      `Applied ${plan.pending.length} migration(s), but schema verification failed. The Worker was not deployed.\n${err instanceof Error ? err.message : String(err)}`,
    )
    return { ok: false, applied: plan.pending.length }
  }
  if (verify.drift.length > 0) console.warn(renderTargetDrift(verify.drift))
  const blocking = verify.drift.filter((change) => change.kind !== 'unexpected-column')
  if (blocking.length > 0 && !opts.force) {
    fail(
      `Stopping before deploy: ${plan.pending.length} migration(s) were applied, but the\nremote schema still does not match. Bypass with --force.`,
    )
    return { ok: false, applied: plan.pending.length }
  }

  return { ok: true, applied: plan.pending.length }
}
