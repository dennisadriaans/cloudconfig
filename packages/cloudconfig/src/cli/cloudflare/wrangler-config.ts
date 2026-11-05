/**
 * Reading and patching the project's wrangler config.
 *
 * Edits are surgical text splices rather than parse-and-reserialize: a
 * wrangler.jsonc is hand-maintained, and rewriting it would drop the comments
 * and ordering the developer put there. TOML is read-only here — a `.toml`
 * project gets a snippet to paste instead of a silent rewrite.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { wranglerConfigPath } from '../wrangler.js'
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'

function document(text: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const json = parse(text, errors, { allowTrailingComma: true }) as unknown
  if (errors.length === 0 && json && typeof json === 'object' && !Array.isArray(json)) {
    return json as Record<string, unknown>
  }
  return parseToml(text) as Record<string, unknown>
}

function firstBinding(text: string, key: string): Record<string, unknown> | undefined {
  const bindings = document(text)[key]
  if (!Array.isArray(bindings) || bindings.length === 0) return undefined
  if (bindings.length > 1) {
    throw new Error(
      `cloudconfig deploy currently requires a single top-level ${key} binding. Multiple bindings are ambiguous.`,
    )
  }
  const binding: unknown = bindings[0]
  if (!binding || typeof binding !== 'object') throw new Error(`Invalid ${key} binding.`)
  return binding as Record<string, unknown>
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function accountIdFrom(text: string): string | undefined {
  return stringValue(document(text)['account_id']) || undefined
}

export interface WranglerFile {
  path: string
  text: string
  format: 'json' | 'toml'
}

export function readWranglerFile(projectDir: string): WranglerFile | undefined {
  const path = wranglerConfigPath(projectDir)
  if (!path) return undefined
  return {
    path,
    text: readFileSync(path, 'utf8'),
    format: path.endsWith('.toml') ? 'toml' : 'json',
  }
}

export function writeWranglerFile(file: WranglerFile, text: string): void {
  writeFileSync(file.path, text)
}

export function readVars(text: string): Record<string, unknown> {
  const vars = document(text)['vars']
  return vars && typeof vars === 'object' && !Array.isArray(vars)
    ? (vars as Record<string, unknown>)
    : {}
}

export function setVar(text: string, name: string, value: string): string {
  return applyEdits(
    text,
    modify(text, ['vars', name], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )
}

/** Worker name from the config; falls back to the config's directory name. */
export function workerNameFrom(text: string, fallback: string): string {
  return stringValue(document(text)['name'], fallback)
}

export interface DeployTarget {
  workerName: string
  /** True when `deploy.worker` names a Worker the wrangler config does not. */
  overridden: boolean
}

/**
 * The one Worker every step of a deploy must address: `wrangler deploy`, the
 * secret list, and the secret push. A `deploy.worker` override that only
 * reached the secret calls used to deploy code and secrets to two Workers.
 */
export function resolveDeployTarget(
  text: string,
  override: string | undefined,
  fallback: string,
): DeployTarget {
  const configured = workerNameFrom(text, fallback)
  const workerName = override ?? configured
  return { workerName, overridden: workerName !== configured }
}

export interface D1Binding {
  binding: string
  databaseName: string
  databaseId: string
}

export function readD1Binding(text: string): D1Binding | undefined {
  const scope = firstBinding(text, 'd1_databases')
  if (!scope) return undefined
  return {
    binding: stringValue(scope['binding'], 'DB'),
    databaseName: stringValue(scope['database_name']),
    databaseId: stringValue(scope['database_id']),
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Scaffolds ship `""` / `local` / `<your-database-id>`; none of those deploy. */
export function isPlaceholderDatabaseId(id: string): boolean {
  return !UUID_RE.test(id.trim())
}

export function setDatabaseId(text: string, id: string): string {
  return applyEdits(text, modify(text, ['d1_databases', 0, 'database_id'], id, {}))
}

export function readR2Binding(text: string): { binding: string; bucketName: string } | undefined {
  const scope = firstBinding(text, 'r2_buckets')
  if (!scope) return undefined
  return {
    binding: stringValue(scope['binding'], 'BUCKET'),
    bucketName: stringValue(scope['bucket_name']),
  }
}

export function readMigrationsDir(text: string): string | undefined {
  return stringValue(firstBinding(text, 'd1_databases')?.['migrations_dir']) || undefined
}

/**
 * Insert a top-level key into a JSON/JSONC object, right after the opening
 * brace so the splice never lands inside a nested block.
 */
function insertTopLevel(text: string, key: string, value: string): string {
  return applyEdits(
    text,
    modify(text, [key], JSON.parse(value), {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )
}

export function addD1Binding(
  text: string,
  opts: { binding: string; databaseName: string; databaseId: string; migrationsDir: string },
): string {
  const block = `[
  {
    "binding": ${JSON.stringify(opts.binding)},
    "database_name": ${JSON.stringify(opts.databaseName)},
    "database_id": ${JSON.stringify(opts.databaseId)},
    "migrations_dir": ${JSON.stringify(opts.migrationsDir)}
  }
]`
  return insertTopLevel(text, 'd1_databases', block)
}

export function addR2Binding(text: string, opts: { binding: string; bucketName: string }): string {
  const block = `[
  {
    "binding": ${JSON.stringify(opts.binding)},
    "bucket_name": ${JSON.stringify(opts.bucketName)}
  }
]`
  return insertTopLevel(text, 'r2_buckets', block)
}

/** Paste-ready snippet for a project we refuse to rewrite (TOML, or no config). */
export function bindingSnippet(opts: {
  binding: string
  databaseName: string
  databaseId: string
  migrationsDir: string
}): string {
  return [
    '"d1_databases": [',
    '  {',
    `    "binding": "${opts.binding}",`,
    `    "database_name": "${opts.databaseName}",`,
    `    "database_id": "${opts.databaseId}",`,
    `    "migrations_dir": "${opts.migrationsDir}"`,
    '  }',
    ']',
  ].join('\n')
}

// Custom domains

/**
 * A Worker route pinned to a hostname the account already owns. Cloudflare
 * issues the certificate and creates the DNS record for a `custom_domain`
 * route, which is why `deploy.domain` needs nothing beyond the hostname —
 * but it also means the zone must exist in the same account before deploying.
 */
export interface CustomDomain {
  pattern: string
  custom_domain: true
}

const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i

/**
 * Reject what Cloudflare would reject, early and by name: a scheme, a path, a
 * port, a wildcard, or a bare label with no dot. `deploy.domain` is a hostname,
 * not a route pattern — the pattern shape is what `routes` is for.
 */
export function isValidCustomDomain(value: string): boolean {
  const host = value.trim()
  if (host.length === 0 || host.length > 253) return false
  if (host.includes('*')) return false
  return HOSTNAME_RE.test(host)
}

export function invalidCustomDomainMessage(value: string): string {
  return [
    `deploy.domain "${value}" is not a hostname.`,
    '',
    '  Expected something like "api.example.com" — no scheme, port, path or wildcard.',
    '  The zone must already exist in the same Cloudflare account.',
  ].join('\n')
}

/** Hostnames the wrangler config already routes to this Worker as custom domains. */
export function readCustomDomains(text: string): string[] {
  const routes = document(text)['routes']
  if (!Array.isArray(routes)) return []
  const hosts: string[] = []
  for (const route of routes) {
    if (!route || typeof route !== 'object') continue
    const entry = route as Record<string, unknown>
    if (entry['custom_domain'] !== true) continue
    const pattern = stringValue(entry['pattern'])
    if (pattern) hosts.push(pattern)
  }
  return hosts
}

/**
 * Append a custom-domain route, preserving any route the project already
 * declares. Appends rather than replaces: a Worker can legitimately answer on
 * several hostnames, and clobbering the array would silently unpublish one.
 */
export function addCustomDomainRoute(text: string, hostname: string): string {
  const routes = document(text)['routes']
  const index = Array.isArray(routes) ? routes.length : 0
  const entry: CustomDomain = { pattern: hostname, custom_domain: true }
  if (!Array.isArray(routes)) {
    return applyEdits(
      text,
      modify(text, ['routes'], [entry], {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    )
  }
  return applyEdits(
    text,
    modify(text, ['routes', index], entry, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  )
}

/** Paste-ready snippet for a project we refuse to rewrite (TOML, or no config). */
export function customDomainSnippet(hostname: string): string {
  return ['"routes": [', `  { "pattern": "${hostname}", "custom_domain": true }`, ']'].join('\n')
}

/** Default resource name for a project: its wrangler Worker name. */
export function defaultResourceName(
  projectDir: string,
  text: string | undefined,
  suffix: string,
): string {
  const base = text ? workerNameFrom(text, basename(projectDir)) : basename(projectDir)
  const safe = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${safe || 'cloudconfig'}-${suffix}`
}
