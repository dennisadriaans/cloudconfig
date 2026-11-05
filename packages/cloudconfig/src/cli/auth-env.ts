/**
 * Where `cloudconfig auth` puts a credential it was just handed.
 *
 * Values go into `.env`, which the dev server and `cloudconfig deploy` both
 * read, so a secret typed once is available locally and on the next deploy.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ENV_FILE } from './cloudflare/secrets.js'

export interface EnvWriteResult {
  file: string
  added: string[]
  replaced: string[]
}

/** Set `KEY=value` lines, replacing an existing assignment in place. */
export function upsertEnvValues(
  projectDir: string,
  file: string,
  values: Record<string, string>,
): EnvWriteResult {
  const path = join(projectDir, file)
  let tracked = false
  try {
    tracked =
      execFileSync('git', ['ls-files', '--error-unmatch', '--', file], {
        cwd: projectDir,
        stdio: 'pipe',
        encoding: 'utf8',
      }).trim().length > 0
  } catch {
    // Not tracked (or not a git checkout).
  }
  if (tracked) {
    throw new Error(
      `Refusing to write credentials to tracked file ${file}. Untrack it before storing secrets.`,
    )
  }
  ensureGitignored(projectDir, file)
  const original = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const lines = original === '' ? [] : original.split('\n')
  const added: string[] = []
  const replaced: string[] = []

  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=`)
    const index = lines.findIndex((line) => pattern.test(line.trim()))
    if (index === -1) {
      added.push(key)
      continue
    }
    lines[index] = `${key}=${value}`
    replaced.push(key)
  }

  let text = lines.join('\n')
  if (added.length > 0) {
    if (text !== '' && !text.endsWith('\n')) text += '\n'
    text += added.map((key) => `${key}=${values[key] as string}`).join('\n') + '\n'
  } else if (text !== '' && !text.endsWith('\n')) {
    text += '\n'
  }
  writeFileSync(path, text)
  return { file, added, replaced }
}

/**
 * Make sure the env file is ignored by git. Writing a client secret into a
 * tracked file is the one failure of this flow that cannot be undone.
 */
export function ensureGitignored(projectDir: string, file: string): boolean {
  const gitignorePath = join(projectDir, '.gitignore')
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : ''
  const ignoreRules = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  const requiredRules = file === ENV_FILE ? [file, '!.env.example'] : [file]
  const finalRules = ignoreRules.slice(-requiredRules.length)
  const hasRequiredRules = requiredRules.every((rule, index) => finalRules[index] === rule)
  if (hasRequiredRules) return false

  // Git applies the last matching rule; earlier exceptions can expose credentials
  // or hide the example after another wildcard is appended.
  const linePrefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
  appendFileSync(gitignorePath, `${linePrefix}${requiredRules.join('\n')}\n`)
  return true
}

/** A URL-safe 32-byte secret, for `BETTER_AUTH_SECRET`. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64url')
}
