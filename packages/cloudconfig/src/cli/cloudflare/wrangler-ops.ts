/**
 * Every wrangler invocation the deploy target makes.
 *
 * Version-specific quirks live here and nowhere else: flag renames, output
 * formats, and Cloudflare's read-after-write lag on freshly created resources.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, runInherit, output, type RunResult } from './exec.js'
import type { PreflightDeps } from './migration-preflight.js'
import { d1PreflightDeps, type D1ExecuteResult } from './d1-remote.js'
import { accountIdFrom, readWranglerFile } from './wrangler-config.js'
import { resolveSecretValues } from './secrets.js'

/**
 * Account-scoped wrangler args: `--config /dev/null` so wrangler skips project
 * config validation. A project with a placeholder `database_id` or a not-yet-
 * created R2 bucket makes wrangler reject its own config on startup and the
 * provisioning command dies before it can fix that very placeholder.
 */
function acct(args: string[]): string[] {
  return [...args, '--config', '/dev/null']
}

function wranglerEnv(projectDir: string, args: string[]): NodeJS.ProcessEnv {
  const file = readWranglerFile(projectDir)
  const { values } = resolveSecretValues(
    [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDCONFIG_D1_ACCOUNT_ID',
      'CLOUDCONFIG_D1_API_TOKEN',
    ],
    projectDir,
  )
  const isDatabaseCommand = args[0] === 'd1'
  const accountId =
    (isDatabaseCommand && values['CLOUDCONFIG_D1_ACCOUNT_ID']) ||
    values['CLOUDFLARE_ACCOUNT_ID'] ||
    (file && accountIdFrom(file.text))
  // A D1-only runtime token cannot authenticate Worker, user, or storage operations.
  const apiToken =
    (isDatabaseCommand && values['CLOUDCONFIG_D1_API_TOKEN']) || values['CLOUDFLARE_API_TOKEN']
  return {
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    ...(apiToken ? { CLOUDFLARE_API_TOKEN: apiToken } : {}),
  }
}

export function wrangler(projectDir: string, args: string[], input?: string): Promise<RunResult> {
  return run('wrangler', args, {
    cwd: projectDir,
    env: wranglerEnv(projectDir, args),
    ...(input !== undefined ? { input } : {}),
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── auth ────────────────────────────────────────────────────────────────────

export async function isAuthenticated(projectDir: string): Promise<boolean> {
  const result = await wrangler(projectDir, acct(['whoami']))
  return result.code === 0
}

// ─── D1 ──────────────────────────────────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * Parse `database_id` out of `d1 create` output. That output is authoritative
 * and immediate; `d1 list` lags a fresh create, which is how a placeholder id
 * gets written and the deploy then fails with API 10021.
 */
export function parseDatabaseId(text: string): string | null {
  const fromJson = text.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i)?.[1]
  if (fromJson) return fromJson
  const fromToml = text.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)?.[1]
  if (fromToml) return fromToml
  return text.match(UUID_RE)?.[0] ?? null
}

/** Look up a D1 id by name. Retries: `d1 list` can lag a recent mutation. */
export async function resolveD1DatabaseId(
  projectDir: string,
  dbName: string,
  attempts = 5,
): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const result = await wrangler(projectDir, acct(['d1', 'list', '--json']))
    const parsed = parseJsonArray(result.stdout)
    for (const entry of parsed ?? []) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry as { name?: unknown }).name === dbName &&
        typeof (entry as { uuid?: unknown }).uuid === 'string'
      ) {
        return (entry as { uuid: string }).uuid
      }
    }
    if (i < attempts - 1) await delay(1500)
  }
  return null
}

export interface D1ProvisionResult {
  id: string | null
  /** Raw wrangler output, so a failure can say *why* instead of "could not create". */
  detail: string
}

export async function provisionD1Database(
  projectDir: string,
  dbName: string,
): Promise<D1ProvisionResult> {
  const result = await wrangler(projectDir, acct(['d1', 'create', dbName]))
  const detail = output(result).trim()
  const id = parseDatabaseId(detail)
  // A create that failed only because the database exists still resolves by name.
  if (id) return { id, detail }
  return { id: await resolveD1DatabaseId(projectDir, dbName), detail }
}

// ─── D1 reads (preflight) ────────────────────────────────────────────────────

/**
 * `d1 execute --remote` is the only remote read path wrangler offers. This is
 * project-scoped: it needs the real binding and database_id from the config.
 */
async function executeD1Sql(
  projectDir: string,
  dbName: string,
  sql: string,
): Promise<D1ExecuteResult[]> {
  const result = await wrangler(projectDir, [
    'd1',
    'execute',
    dbName,
    '--remote',
    '--json',
    '--command',
    sql,
  ])
  if (result.code !== 0) throw new Error(output(result).trim())
  const parsed = parseTrailingJsonArray(result.stdout)
  if (!parsed) throw new Error('Could not parse wrangler d1 execute output.')
  return parsed as D1ExecuteResult[]
}

/** Wire the pure preflight engine to real wrangler reads. */
export function cloudflarePreflightDeps(projectDir: string, dbName: string): PreflightDeps {
  return d1PreflightDeps((sql) => executeD1Sql(projectDir, dbName, sql))
}

/** Apply pending migrations remotely. Project-scoped: needs the real binding. */
export async function applyRemoteMigrations(projectDir: string, dbName: string): Promise<number> {
  const args = ['d1', 'migrations', 'apply', dbName, '--remote']
  return runInherit('wrangler', args, {
    cwd: projectDir,
    env: wranglerEnv(projectDir, args),
  })
}

// ─── R2 ──────────────────────────────────────────────────────────────────────

export interface R2ProvisionResult {
  ok: boolean
  /** True when the bucket was already there — not an error, just not created. */
  existed: boolean
  detail: string
}

export async function createR2Bucket(
  projectDir: string,
  bucketName: string,
): Promise<R2ProvisionResult> {
  const result = await wrangler(projectDir, acct(['r2', 'bucket', 'create', bucketName]))
  const detail = output(result).trim()
  if (result.code === 0) return { ok: true, existed: false, detail }
  const existed = /already exists|10004/i.test(detail)
  return { ok: existed, existed, detail }
}

// ─── secrets ─────────────────────────────────────────────────────────────────

/** Cloudflare's own Worker-name constraint; asserted before it reaches argv. */
const WORKER_NAME_RE = /^[A-Za-z0-9_-]+$/

export function isValidWorkerName(name: string): boolean {
  return WORKER_NAME_RE.test(name)
}

/** Wrangler's documented ceiling for one `secret bulk` request. */
export const SECRET_BULK_LIMIT = 100

/**
 * Names of the secrets already set on the Worker.
 *
 * Two flag spellings because wrangler renamed `--json` to `--format json` and
 * the old spelling now exits with a usage error — swallowing that made every
 * remote secret look missing.
 */
export async function listSecrets(projectDir: string, workerName: string): Promise<string[]> {
  if (!WORKER_NAME_RE.test(workerName)) return []
  for (const flag of [['--format', 'json'], ['--json']]) {
    const result = await wrangler(
      projectDir,
      acct(['secret', 'list', '--name', workerName, ...flag]),
    )
    if (result.code !== 0) continue
    const parsed = parseJsonArray(result.stdout)
    if (!parsed) continue
    return parsed
      .filter(
        (secret): secret is { name: string } =>
          !!secret && typeof secret === 'object' && 'name' in secret,
      )
      .map((secret) => secret.name)
  }
  return []
}

/**
 * Create, update, and delete Worker secrets in one request per batch.
 *
 * The payload goes to stdin, never argv: a command string is readable by every
 * process on the machine via `ps`, and these are production credentials. A
 * `null` value is `secret bulk`'s delete verb.
 *
 * Retries because a Worker is not globally consistent immediately after its
 * first deploy, so secret writes can fail with "script not found" even though
 * the deploy succeeded.
 */
export async function putSecretsBulk(
  projectDir: string,
  workerName: string,
  secrets: Record<string, string | null>,
  attempts = 6,
): Promise<void> {
  const keys = Object.keys(secrets)
  if (keys.length === 0) return
  if (!WORKER_NAME_RE.test(workerName)) {
    throw new Error(`Refusing to run wrangler against an unexpected Worker name: ${workerName}`)
  }

  for (let start = 0; start < keys.length; start += SECRET_BULK_LIMIT) {
    const batch: Record<string, string | null> = {}
    for (const key of keys.slice(start, start + SECRET_BULK_LIMIT)) {
      batch[key] = secrets[key] ?? null
    }
    await runSecretBulk(projectDir, workerName, batch, attempts)
  }
}

const TRANSIENT_RE = /not found|10007|10090|workers\.api\.error|could not resolve|does not exist/i

async function runSecretBulk(
  projectDir: string,
  workerName: string,
  batch: Record<string, string | null>,
  attempts: number,
): Promise<void> {
  const args = acct(['secret', 'bulk', '--name', workerName])
  for (let i = 0; i < attempts; i++) {
    const result = await wrangler(projectDir, args, JSON.stringify(batch))
    if (result.code === 0) return
    const detail = output(result).trim()
    // Auth and quota errors never fix themselves — only retry propagation lag.
    if (!TRANSIENT_RE.test(detail) || i === attempts - 1) throw new Error(detail)
    await delay(2000 * (i + 1))
  }
}

// ─── deploy ──────────────────────────────────────────────────────────────────

export interface WorkerDeployResult extends RunResult {
  /** The secrets were uploaded with the new version, so none remain to push. */
  secretsUploaded: boolean
}

/**
 * Deploy the Worker, with its secrets in the same version.
 *
 * `name` is passed explicitly whenever it was resolved from something other than
 * the wrangler config (a `deploy.worker` override): otherwise wrangler deploys
 * under its own configured name while secrets are pushed to the overridden one,
 * and the two halves of a deploy land on different Workers.
 *
 * Secrets travel through `--secrets-file`, so a first deploy never serves
 * requests without them. The file lives in a private temporary directory that
 * is removed afterwards. A wrangler too old for the flag deploys without it and
 * reports `secretsUploaded: false`, leaving the caller to push them separately.
 */
export async function deployWorker(
  projectDir: string,
  name?: string,
  secrets: Record<string, string> = {},
): Promise<WorkerDeployResult> {
  if (name !== undefined && !WORKER_NAME_RE.test(name)) {
    throw new Error(`Refusing to run wrangler against an unexpected Worker name: ${name}`)
  }
  const args = name === undefined ? ['deploy'] : ['deploy', '--name', name]
  if (Object.keys(secrets).length > 0) {
    const directory = mkdtempSync(join(tmpdir(), 'cloudconfig-secrets-'))
    try {
      const file = join(directory, 'secrets.json')
      writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 })
      const result = await wrangler(projectDir, [...args, '--secrets-file', file])
      if (!UNKNOWN_SECRETS_FLAG_RE.test(output(result))) {
        process.stdout.write(result.stdout)
        process.stderr.write(result.stderr)
        return { ...result, secretsUploaded: result.code === 0 }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  const result = await wrangler(projectDir, args)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  return { ...result, secretsUploaded: false }
}

const UNKNOWN_SECRETS_FLAG_RE = /unknown (argument|option)s?:?.*secrets-file/i

/** The workers.dev URL printed by a first deploy (no custom domain). */
export function extractWorkersUrl(text: string): string | null {
  return text.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)?.[0] ?? null
}

// ─── parsing ─────────────────────────────────────────────────────────────────

function parseJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[')
  if (start === -1) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Scan right-to-left for the last parseable JSON array; wrangler prefixes banners. */
function parseTrailingJsonArray(text: string): unknown[] | null {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '[') continue
    try {
      const parsed: unknown = JSON.parse(text.slice(i))
      if (Array.isArray(parsed)) return parsed
    } catch {
      // keep scanning left
    }
  }
  return null
}
