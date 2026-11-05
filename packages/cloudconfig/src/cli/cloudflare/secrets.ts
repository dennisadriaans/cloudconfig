/**
 * Secret planning for `cloudconfig deploy`.
 *
 * Values come from the project's `.env` file or, for a declared secret, from
 * the process environment. Deploy has to be runnable in CI, so a missing secret
 * blocks with a named list instead of prompting.
 *
 * Precedence is `process.env` first, then `.env`. CI
 * is the authoritative source when it sets a variable at all, so a pipeline can
 * rotate a secret without editing a file that a developer machine also has.
 * Only DECLARED names are ever read from the environment.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Shared local settings file for development, credential setup, and deploy. */
export const ENV_FILE = '.env'

export interface SecretPlan {
  /** Declared, found locally, and not already identical on the Worker. */
  toPush: string[]
  /** Declared but absent locally — blocks the deploy. */
  missing: string[]
  /** Declared, already present on the Worker, and not found locally to re-push. */
  remoteOnly: string[]
}

/** Parse `KEY=value` lines. Quotes are stripped; `export` prefixes are ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = (match[2] ?? '').trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    out[match[1] as string] = value
  }
  return out
}

/** Read local settings from `.env`; `.env.example` is never a source of values. */
export function readLocalSecrets(projectDir: string): Record<string, string> {
  const path = join(projectDir, ENV_FILE)
  if (!existsSync(path)) return {}
  return parseEnvFile(readFileSync(path, 'utf8'))
}

/**
 * Values for the declared secrets, environment first, then `.env`.
 *
 * `sources` says where each value came from, so the deploy can print it — a
 * secret silently taken from a stray shell variable is worth naming.
 */
export function resolveSecretValues(
  declared: readonly string[],
  projectDir: string,
  env: Record<string, string | undefined> = process.env,
): { values: Record<string, string>; sources: Record<string, 'env' | 'file'> } {
  const files = readLocalSecrets(projectDir)
  const values: Record<string, string> = {}
  const sources: Record<string, 'env' | 'file'> = {}
  for (const key of declared) {
    const fromEnv = env[key]
    if (typeof fromEnv === 'string') {
      values[key] = fromEnv
      sources[key] = 'env'
      continue
    }
    const fromFile = files[key]
    if (typeof fromFile === 'string' && fromFile !== '') {
      values[key] = fromFile
      sources[key] = 'file'
    }
  }
  return { values, sources }
}

export function buildSecretPlan(
  declared: readonly string[],
  local: Record<string, string>,
  remoteNames: readonly string[],
): SecretPlan {
  const remote = new Set(remoteNames)
  const plan: SecretPlan = { toPush: [], missing: [], remoteOnly: [] }
  for (const key of declared) {
    const value = local[key]
    // Wrangler never discloses a secret's value, so a locally-present secret is
    // always re-pushed: that is the only way a rotated value reaches the Worker.
    if (value !== undefined && value !== '') plan.toPush.push(key)
    else if (remote.has(key)) plan.remoteOnly.push(key)
    else plan.missing.push(key)
  }
  return plan
}

export function missingSecretsMessage(missing: readonly string[]): string {
  return [
    `Missing ${missing.length} required secret(s): ${missing.join(', ')}`,
    '',
    `  Set them in ${ENV_FILE} (git-ignored), export them in the environment`,
    '  (how CI supplies them), or push them yourself:',
    ...missing.map((key) => `    wrangler secret put ${key}`),
    '',
    '  They are declared in cloud.config.ts — under deploy.secrets, or required',
    '  by the auth block (run `cloudconfig auth status` to see which).',
  ].join('\n')
}
