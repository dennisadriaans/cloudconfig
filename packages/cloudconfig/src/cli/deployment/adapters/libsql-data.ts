import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createClient } from '@libsql/client/web'
import { databaseEnvNames, validateRemoteDatabaseUrl } from '../../../shared/data-env.js'
import { resolveSecretValues } from '../../cloudflare/secrets.js'
import {
  buildMigrationPlan,
  listLocalMigrationFiles,
  planBlocks,
  verifyTargetSchema,
  type PreflightDeps,
} from '../migrations/preflight.js'
import { renderReport } from '../migrations/report.js'
import { assertSettings } from '../settings.js'
import type { DataDeployment, DeploymentRequest } from '../ports.js'

export function libsqlDeployment(
  request: DeploymentRequest,
  migrationsDir: string,
): DataDeployment {
  const names = databaseEnvNames(request.config)
  const { values: env } = resolveSecretValues([names.url, names.token], request.projectDir)
  assertSettings([names.url, names.token], env)
  validateRemoteDatabaseUrl(env[names.url]!)
  return {
    env,
    async migrate() {
      const client = createClient({ url: env[names.url]!, authToken: env[names.token]! })
      try {
        const ledgerExists = await client.execute(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='_cloudconfig_remote_migrations'",
        )
        const ledger = ledgerExists.rows.length
          ? await client.execute(
              'SELECT name, checksum FROM _cloudconfig_remote_migrations ORDER BY name',
            )
          : { rows: [] }
        const files = listLocalMigrationFiles(migrationsDir)
        const checksum = (file: string) =>
          createHash('sha256')
            .update(readFileSync(join(migrationsDir, file)))
            .digest('hex')
        for (const row of ledger.rows) {
          const file = String(row['name'])
          if (!files.includes(file) || checksum(file) !== row['checksum']) {
            throw new Error(
              `Applied migration ${file} was changed or removed. Restore it before deploying.`,
            )
          }
        }
        const deps: PreflightDeps = {
          listAppliedMigrations: async () => ledger.rows.map((row) => String(row['name'])),
          readRemoteTableColumns: async (table) => {
            const rows = await client.execute(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
            return rows.rows.map((row) => ({
              name: String(row['name']),
              type: String(row['type']),
            }))
          },
        }
        const plan = await buildMigrationPlan(migrationsDir, deps)
        if (planBlocks(plan) && !request.options.force) throw new Error(renderReport(plan))
        if (request.options.dryRun) {
          console.log(`Shared libSQL database: ${plan.pending.length} pending migration(s).`)
          if (plan.pending.length) console.log(plan.pending.join('\n'))
          return
        }
        if (plan.pending.length) {
          // One atomic migration batch, including ledger entries. A concurrent deploy fails its
          // unique ledger insert and rolls back rather than applying a migration twice.
          const statements = [
            {
              sql: 'CREATE TABLE IF NOT EXISTS _cloudconfig_remote_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)',
              args: [] as string[],
            },
          ]
          for (const file of plan.pending) {
            const sql = readFileSync(join(migrationsDir, file), 'utf8')
            for (const statement of sql
              .split('--> statement-breakpoint')
              .map((part) => part.trim())
              .filter(Boolean)) {
              statements.push({ sql: statement, args: [] })
            }
            statements.push({
              sql: 'INSERT INTO _cloudconfig_remote_migrations (name, checksum) VALUES (?, ?)',
              args: [file, checksum(file)],
            })
          }
          await client.migrate(statements)
        }
        const verified = await verifyTargetSchema(migrationsDir, deps)
        if (
          verified.drift.some((change) => change.kind !== 'unexpected-column') &&
          !request.options.force
        ) {
          throw new Error(
            'Remote schema does not match the migration snapshots after applying migrations. No app was published.',
          )
        }
      } finally {
        client.close()
      }
    },
  }
}
