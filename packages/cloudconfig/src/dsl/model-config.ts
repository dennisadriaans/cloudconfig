import type { AuthConfig } from './auth-config.js'
import type { ConnectConfig } from './connect-config.js'
import type { AnyField } from './fields.js'
import type { ModelOptions } from './filters.js'
import type { AutomationSchedule } from '../automations/types.js'

export interface Model<TFields extends Record<string, AnyField>> {
  readonly fields: TFields
  readonly options: ModelOptions
}

/** Any model — used where the field shape doesn't matter. */
export type AnyModel = Model<Record<string, AnyField>>

export type DatabaseProvider = 'd1' | 'turso' | 'libsql'

export type RemoteDatabaseConfig =
  { provider: 'd1' } | { provider: 'turso' | 'libsql'; urlEnv?: string; tokenEnv?: string }

export function model<TFields extends Record<string, AnyField>>(
  fields: TFields,
  options: ModelOptions = {},
): Model<TFields> {
  return { fields, options }
}

export interface CloudConfigConfig<
  TModels extends Record<string, AnyModel> = Record<string, AnyModel>,
> {
  models: TModels
  server?: {
    basePath?: string
    /** Serve the HTML reference at /_docs and OpenAPI 3.1 at /openapi.json. Default true. */
    docs?: boolean
  }
  db?: {
    /** Production database. Defaults to Turso on Vercel and D1 elsewhere. Pin before switching hosts. */
    remote?: RemoteDatabaseConfig
    migrationsDir?: string
    /** D1 database name for `cloudconfig deploy`. Defaults to `<worker>-db`. */
    name?: string
    /** SQLite file for local development. Defaults to `.cloudconfig/dev.db`. */
    local?: string
    /** Cloudflare D1 binding name. Defaults to `DB`. */
    binding?: string
  }
  /** Fallback for actions with no rule. Defaults to `deny`: public access is opt-in. */
  access?: { default?: 'allow' | 'deny' }
  /**
   * Sign-in. Adding this block makes CloudConfig own the user/session/account tables
   * and mount better-auth under `<basePath>/auth`; see `cloudconfig auth add`.
   */
  auth?: AuthConfig
  /**
   * Third-party connections (OAuth apps, hosted MCP servers, API keys) that
   * server code uses on a user's or an organization's behalf. Requires `auth`;
   * see `cloudconfig connect add`.
   */
  connect?: ConnectConfig
  /** Shared object storage, independent of deploy.target. Local development uses storage.local. */
  storage?: {
    provider: 's3'
    /** Environment variables holding the endpoint, bucket and credentials. */
    endpointEnv?: string
    bucketEnv?: string
    accessKeyIdEnv?: string
    secretAccessKeyEnv?: string
    region?: string
  }
  deploy?: DeployConfig
}

/** Any config — used by the inference helpers below. */
export type AnyConfig = CloudConfigConfig<Record<string, AnyModel>>

/**
 * Type-anchoring identity function. Deliberately does NO validation — importing
 * a config module must never throw (it may run in a browser bundle). All
 * validation happens in `compileConfig` on the server.
 */
export function defineBackend<T extends Record<string, AnyModel>>(
  config: CloudConfigConfig<T>,
): CloudConfigConfig<T> {
  return config
}

/** What `cloudconfig deploy` provisions and pushes. Every field has a derived default. */
export interface DeployConfig {
  /** App host. Changing this never moves or deletes database or storage contents. Default cloudflare. */
  target?: DeploymentTarget
  /** Stable application name on each host. Defaults to the project directory name. */
  name?: string
  /** Standalone Web handler module (default export with fetch). Omitted builds the configured backend. */
  entry?: string
  vercel?: { scope?: string; project?: string }
  azure?: {
    subscription?: string
    resourceGroup?: string
    location?: string
    /** App Service plan tier; default B1. */
    sku?: string
    /** Separate native Durable Functions app and its private Storage account. Omitted names are derived. */
    agents?: { appName?: string; storageAccount?: string }
  }
  /** SQLite Durable Object Agent classes exported by the Worker. */
  agents?: AgentDeployment[]
  /** Portable agent host. Execution uses the selected cloud's durable runtime. */
  agent?: {
    entry: string
    /** Optional names for the Cloudflare Agent class and binding. */
    cloudflare?: { className?: string; binding?: string; migrationTag?: string }
  }
  /** Portable checkpointed jobs and cron schedules on the selected cloud. */
  automations?: {
    entry: string
    cloudflare?: { className?: string; binding?: string; migrationTag?: string }
    schedules?: Record<string, AutomationSchedule>
  }
  /** Durable multi-step jobs exported by the same Worker. */
  workflows?: WorkflowDeployment[]
  /** Cloudflare Worker name. Defaults to the wrangler config's `name`. */
  worker?: string
  /**
   * Hostname to serve the Worker from, e.g. `api.example.com`. `cloudconfig deploy`
   * adds it to the wrangler config as a custom-domain route; Cloudflare issues
   * the certificate and the DNS record. The zone must already exist in the same
   * account. Omitted means the generated `workers.dev` URL.
   */
  domain?: string
  /** D1 database name. Defaults to `db.name`, then `<worker>-db`. */
  d1?: string
  /** R2 bucket to provision for file storage. Omitted means no bucket. */
  r2?: string
  /** Binding name for that bucket. */
  r2Binding?: string
  /** Secrets that must exist on the Worker before a deploy is allowed. */
  secrets?: string[]
  /** Push these when supplied locally; their absence does not block unrelated providers. */
  optionalSecrets?: string[]
  /** Provision a managed Turnstile widget and sync its public key and secret. */
  turnstile?:
    | true
    | {
        /** Adopt an existing widget. Otherwise reuse the saved public key or worker-named widget. */
        siteKey?: string
        /** Additional allowed hostnames; deploy.domain and custom-domain routes are included. */
        domains?: string[]
        /** Public variable name. Defaults to NUXT_PUBLIC_TURNSTILE_SITE_KEY for Nuxt,
         * NEXT_PUBLIC_TURNSTILE_SITE_KEY for Next, otherwise TURNSTILE_SITE_KEY. */
        siteKeyBinding?: string
      }
}

export type DeploymentTarget = 'cloudflare' | 'vercel' | 'azure'

export interface WorkerExport {
  /** Server-only source file, relative to the project root. */
  entry: string
  className: string
  binding: string
}
export interface AgentDeployment extends WorkerExport {
  /** Immutable migration tag used when this SQLite class is first deployed. */
  migrationTag: string
}
export interface WorkflowDeployment extends WorkerExport {
  name: string
}
