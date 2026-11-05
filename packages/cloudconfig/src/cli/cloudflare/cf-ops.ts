/**
 * Every `cf` invocation the deploy target makes for a project with `cloudflare.config.ts`.
 *
 * cf is in beta, so its flags, JSON shapes and Build Output paths live here and
 * nowhere else. Results go to stdout as JSON; messages and errors go to stderr.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { run, runInherit, output, type RunResult } from './exec.js'
import { d1PreflightDeps, type D1ExecuteResult } from './d1-remote.js'
import type { RemoteD1 } from './deploy-data.js'
import { resolveSecretValues } from './secrets.js'

export const CLOUDFLARE_CONFIG_FILE = 'cloudflare.config.ts'

/** Where `cf build` writes the default Worker's resolved configuration. */
export const BUILD_OUTPUT_WORKER_CONFIG = '.cloudflare/output/v0/workers/default/worker.config.json'

/** True when the project configures Cloudflare through cf's `cloudflare.config.ts`. */
export function hasCloudflareConfig(projectDir: string): boolean {
  return existsSync(join(projectDir, CLOUDFLARE_CONFIG_FILE))
}

/** Walk up from `projectDir` looking for `node_modules/.bin/cf`, like `withLocalBin`. */
export function hasLocalCfBin(projectDir: string, maxDepth = 6): boolean {
  let current = projectDir
  for (let depth = 0; depth < maxDepth; depth++) {
    if (existsSync(join(current, 'node_modules', '.bin', 'cf'))) return true
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return false
}

// A D1-only runtime token cannot authenticate Worker, user, or storage operations.
function cfEnv(projectDir: string, args: string[]): NodeJS.ProcessEnv {
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
    (isDatabaseCommand && values['CLOUDCONFIG_D1_ACCOUNT_ID']) || values['CLOUDFLARE_ACCOUNT_ID']
  const apiToken =
    (isDatabaseCommand && values['CLOUDCONFIG_D1_API_TOKEN']) || values['CLOUDFLARE_API_TOKEN']
  return {
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
    ...(apiToken ? { CLOUDFLARE_API_TOKEN: apiToken } : {}),
  }
}

export function cf(projectDir: string, args: string[]): Promise<RunResult> {
  return run('cf', args, { cwd: projectDir, env: cfEnv(projectDir, args) })
}

function cfInherit(projectDir: string, args: string[]): Promise<number> {
  return runInherit('cf', args, { cwd: projectDir, env: cfEnv(projectDir, args) })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ─── auth ────────────────────────────────────────────────────────────────────

export async function isCfAuthenticated(projectDir: string): Promise<boolean> {
  const result = await cf(projectDir, ['auth', 'whoami'])
  if (result.code !== 0) return false
  const status = parseJson(result.stdout) as { authenticated?: unknown } | undefined
  return status?.authenticated === true
}

// ─── D1 ──────────────────────────────────────────────────────────────────────

/** The id of the database with exactly this name; `--name` also matches substrings. */
export async function findD1DatabaseId(projectDir: string, name: string): Promise<string | null> {
  const result = await cf(projectDir, ['d1', 'list', '--name', name])
  if (result.code !== 0) throw new Error(output(result).trim())
  const list = parseJson(result.stdout)
  if (!Array.isArray(list)) return null
  const match = list.find(
    (entry): entry is { uuid: string } =>
      !!entry &&
      typeof entry === 'object' &&
      (entry as { name?: unknown }).name === name &&
      typeof (entry as { uuid?: unknown }).uuid === 'string',
  )
  return match?.uuid ?? null
}

export async function createD1Database(projectDir: string, name: string): Promise<string> {
  const result = await cf(projectDir, ['d1', 'create', '--name', name])
  if (result.code !== 0) throw new Error(output(result).trim())
  const created = parseJson(result.stdout) as { uuid?: unknown } | undefined
  if (typeof created?.uuid === 'string') return created.uuid
  const id = await findD1DatabaseId(projectDir, name)
  if (!id) throw new Error(`cf created "${name}" but did not report its id.`)
  return id
}

/** cf addresses remote databases by id only; names and binding names are rejected. */
export function cfRemoteD1(
  projectDir: string,
  databaseId: string,
  migrationsDir: string,
): RemoteD1 {
  return {
    deps: d1PreflightDeps(async (sql) => {
      const result = await cf(projectDir, ['d1', 'query', databaseId, '--sql', sql])
      if (result.code !== 0) throw new Error(output(result).trim())
      const parsed = parseJson(result.stdout)
      if (!Array.isArray(parsed)) throw new Error('Could not parse cf d1 query output.')
      return parsed as D1ExecuteResult[]
    }),
    apply: () =>
      cfInherit(projectDir, ['d1', 'migrations', 'apply', databaseId, '--dir', migrationsDir]),
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────────

/** Secret names on the Worker; empty when it has never been deployed. */
export async function listCfSecrets(projectDir: string, workerName: string): Promise<string[]> {
  const result = await cf(projectDir, ['workers', 'secrets', 'list', '--worker', workerName])
  if (result.code !== 0) return []
  const list = parseJson(result.stdout)
  if (!Array.isArray(list)) return []
  return list
    .map((entry) =>
      entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : null,
    )
    .filter((name): name is string => typeof name === 'string')
}

/** A binding as cf writes it to the Build Output: `{ type, ...options }`. */
export interface BuiltBinding {
  type: string
  id?: string
  name?: string
}

/** The fields of the built Worker configuration that deploy checks. */
export interface BuiltWorker {
  name: string
  env: Record<string, BuiltBinding>
  domains: string[]
}

/** Run the framework build through cf, producing the Build Output that deploy uploads. */
export function cfBuild(projectDir: string): Promise<number> {
  return cfInherit(projectDir, ['build'])
}

export function readBuiltWorker(projectDir: string): BuiltWorker | undefined {
  const path = join(projectDir, BUILD_OUTPUT_WORKER_CONFIG)
  if (!existsSync(path)) return undefined
  const config = parseJson(readFileSync(path, 'utf8')) as
    { name?: unknown; env?: unknown; domains?: unknown } | undefined
  if (typeof config?.name !== 'string') return undefined
  const env = config.env && typeof config.env === 'object' ? config.env : {}
  // A string serves production; an object only when its `production` flag is set.
  const domains = Array.isArray(config.domains)
    ? config.domains
        .map((domain: unknown) => {
          if (typeof domain === 'string') return domain
          const custom = domain as { hostname?: unknown; production?: unknown } | null
          return custom?.production === true ? custom.hostname : undefined
        })
        .filter((domain): domain is string => typeof domain === 'string')
    : []
  return { name: config.name, env: env as Record<string, BuiltBinding>, domains }
}

/**
 * Upload the prebuilt Worker with its secrets in the same version.
 *
 * Values go through a 0600 file that is removed afterwards, never argv. cf keeps
 * secrets already on the Worker and uploads only keys the config declares.
 */
export async function cfDeploy(
  projectDir: string,
  secrets: Record<string, string>,
): Promise<number> {
  const args = ['deploy', '--prebuilt']
  if (Object.keys(secrets).length === 0) return cfInherit(projectDir, args)
  const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-cf-secrets-'))
  const file = join(dir, 'secrets.json')
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 })
    return await cfInherit(projectDir, [...args, '--secrets-file', file])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
