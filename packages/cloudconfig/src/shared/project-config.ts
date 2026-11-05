/**
 * The single resolved project contract.
 *
 * Mount path, migrations folder, local database file and D1 binding are read by
 * three layers that must agree: the CLI (`cloudconfig db`, `cloudconfig deploy`), the
 * generated drizzle-kit shim, and a framework module at runtime. Each layer
 * defaulting on its own is how `basePath` ended up routed one way and served
 * another — so every default lives here and nowhere else.
 */
import { LOCAL_DB_PATH } from './local-db.js'
import type { AnyConfig } from '../dsl/model-config.js'

export const DEFAULT_BASE_PATH = '/api'
export const DEFAULT_MIGRATIONS_DIR = 'migrations'
export const DEFAULT_D1_BINDING = 'DB'

export interface ResolvedProjectConfig {
  /** Mount path, no trailing slash, always leading slash. */
  basePath: string
  /** Migrations folder, relative to the project root. */
  migrationsDir: string
  /** SQLite file used when no D1 binding is present. */
  localDbPath: string
  /** Cloudflare D1 binding name. */
  d1Binding: string
  /** Explicit D1 database name, when the config names one. */
  dbName: string | undefined
}

export function normalizeBasePath(input: string | undefined): string {
  if (!input) return DEFAULT_BASE_PATH
  const trimmed = input.trim().replace(/\/+$/, '')
  if (trimmed === '') return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function resolveProjectConfig(config: AnyConfig): ResolvedProjectConfig {
  return {
    basePath: normalizeBasePath(config.server?.basePath),
    migrationsDir: config.db?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR,
    localDbPath: config.db?.local ?? LOCAL_DB_PATH,
    d1Binding: config.db?.binding ?? DEFAULT_D1_BINDING,
    dbName: config.db?.name,
  }
}
