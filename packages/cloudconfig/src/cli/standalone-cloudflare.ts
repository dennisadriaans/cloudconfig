import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { readWranglerFile } from './cloudflare/wrangler-config.js'

/** Add the Worker defaults without replacing existing deployment settings. */
export function configureStandaloneCloudflare(projectDir: string): void {
  const existing = readWranglerFile(projectDir)
  if (existing?.format === 'toml') {
    throw new Error('Standalone deploy needs wrangler.jsonc. Convert wrangler.toml first.')
  }

  let text = existing ? readFileSync(existing.path, 'utf8') : '{}\n'
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Wrangler JSON configuration.')
  }
  const config = parsed as Record<string, unknown>
  if (config['main'] && config['main'] !== 'worker.ts') {
    throw new Error('Existing Wrangler main conflicts with the standalone Worker entry.')
  }
  const flags = config['compatibility_flags']
  if (
    flags !== undefined &&
    (!Array.isArray(flags) || !flags.every((flag) => typeof flag === 'string'))
  ) {
    throw new Error('Existing Wrangler compatibility_flags must be a list of strings.')
  }
  const name = basename(resolve(projectDir))
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
  const changes: [string[], unknown][] = [
    [['name'], config['name'] ?? (name || 'cloudconfig-app')],
    [['main'], 'worker.ts'],
    [['compatibility_date'], config['compatibility_date'] ?? new Date().toISOString().slice(0, 10)],
    [
      ['compatibility_flags'],
      [...new Set([...(Array.isArray(flags) ? flags : []), 'nodejs_compat'])],
    ],
    [['workers_dev'], config['workers_dev'] ?? true],
    [['vars', 'NODE_ENV'], 'production'],
  ]
  for (const [path, value] of changes) {
    text = applyEdits(
      text,
      modify(text, path, value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    )
  }
  writeFileSync(
    existing?.path ?? join(projectDir, 'wrangler.jsonc'),
    text.endsWith('\n') ? text : `${text}\n`,
  )
}
