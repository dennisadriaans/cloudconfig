import { posix } from 'node:path'
import {
  agentDeployment,
  automationDeployment,
  resolveProjectConfig,
  workerExports,
  type AnyConfig,
} from '../index.js'
import { normalizeVoidSourceDirectory } from './paths.js'

export interface VoidBackendOptions {
  name: string
  compatibilityDate: string
  /** Omit for Void's normal project-root conventions. */
  sourceDir?: string
  appType?: 'void' | 'framework'
  build?: string
  scanDirs?: readonly string[]
  /** Requires the Void 1.1.11 coexistence patch until accepted upstream. */
  preserveWranglerConfig?: boolean
  /** Requires the coexistence patch; .env.example is retained but never loaded. */
  preserveEnvExample?: boolean
  databaseId?: string
  databaseName?: string
  storageName?: string
  /** Override by binding when intentionally reusing an existing Workflow. */
  workflowNames?: Record<string, string>
  crons?: string[]
}

/** Derive Void resources from defineBackend without imposing a framework or moving application sources. */
export function createVoidBackendConfig(config: AnyConfig, options: VoidBackendOptions) {
  if (config.deploy?.target && config.deploy.target !== 'cloudflare') {
    throw new Error('The Void bridge requires a Cloudflare deployment target.')
  }
  if (config.db?.remote && config.db.remote.provider !== 'd1') {
    throw new Error('The Void bridge currently supports D1 databases.')
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.name)) {
    throw new Error('Give the Void deployment a lowercase Worker name.')
  }
  workerExports(config.deploy)
  const sourceDir = normalizeVoidSourceDirectory(options.sourceDir)
  const { d1Binding } = resolveProjectConfig(config)
  const agent = agentDeployment(config.deploy)
  const automation = automationDeployment(config.deploy)
  const durableHosts = [...(agent ? [agent] : []), ...(automation ? [automation] : [])]
  const migrationClasses = new Map<string, string[]>()
  for (const { migrationTag, className } of durableHosts) {
    const classes = migrationClasses.get(migrationTag) ?? []
    classes.push(className)
    migrationClasses.set(migrationTag, classes)
  }
  const appType: 'void' | 'framework' = options.appType ?? 'void'
  const hasStorage = Boolean(config.deploy?.r2)

  return {
    ...(sourceDir ? { sourceDir } : {}),
    inference: {
      appType,
      ...(options.build ? { build: options.build } : {}),
      ...(options.scanDirs ? { scanDirs: options.scanDirs } : {}),
      ...(options.preserveWranglerConfig ? { preserveWranglerConfig: true } : {}),
      ...(options.preserveEnvExample ? { preserveEnvExample: true } : {}),
      bindings: {
        db: d1Binding,
        ...(hasStorage ? { storage: config.deploy?.r2Binding ?? 'FILES' } : {}),
      },
    },
    cloudflare: {
      name: options.name,
      compatibility_date: options.compatibilityDate,
      compatibility_flags: ['nodejs_compat', 'nodejs_als'],
      vars: { NODE_ENV: 'production' },
      d1_databases: [
        {
          binding: d1Binding,
          database_name: options.databaseName ?? `${options.name}-db`,
          ...(options.databaseId ? { database_id: options.databaseId } : {}),
          migrations_dir: posix.join(sourceDir, 'db/migrations'),
        },
      ],
      ...(hasStorage
        ? {
            r2_buckets: [
              {
                binding: config.deploy?.r2Binding ?? 'FILES',
                bucket_name: options.storageName ?? `${options.name}-assets`,
              },
            ],
          }
        : {}),
      ...(durableHosts.length
        ? {
            durable_objects: {
              bindings: durableHosts.map(({ binding, className }) => ({
                name: binding,
                class_name: className,
              })),
            },
            migrations: [...migrationClasses].map(([tag, classes]) => ({
              tag,
              new_sqlite_classes: classes,
            })),
          }
        : {}),
      ...(config.deploy?.workflows?.length
        ? {
            workflows: config.deploy.workflows.map(({ binding, className }) => ({
              name: options.workflowNames?.[binding] ?? `${options.name}-${binding.toLowerCase()}`,
              binding,
              class_name: className,
            })),
          }
        : {}),
      ...(options.crons?.length ? { triggers: { crons: options.crons } } : {}),
    },
  }
}
