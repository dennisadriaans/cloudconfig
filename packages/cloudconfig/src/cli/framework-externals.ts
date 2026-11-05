/**
 * Ensure Next.js / Nuxt mark `better-sqlite3` as external so the native
 * module is not bundled. `cloudconfig init` scaffolds mounts that import
 * `cloudconfig/drivers/better-sqlite3`; without this, framework bundlers fail
 * with opaque native-binding / resolve errors.
 *
 * Strategy (safe, non-AST):
 * 1. Write a minimal config when none exists.
 * 2. If a config already lists `better-sqlite3`, leave it alone.
 * 3. For common starter shapes, inject the known key/array entry.
 * 4. Otherwise return a manual hint — never rewrite opaque configs.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Framework } from './detect.js'

const NEXT_CONFIG_NAMES = [
  'next.config.ts',
  'next.config.mts',
  'next.config.js',
  'next.config.mjs',
  'next.config.cjs',
] as const

const NUXT_CONFIG_NAMES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'] as const

export const NEXT_EXTERNAL_HINT =
  "Add serverExternalPackages: ['better-sqlite3'] to your Next config (native module)."

export const NUXT_EXTERNAL_HINT =
  "Add nitro.externals.external: ['better-sqlite3'] to your Nuxt config (native module)."

export const NEXT_MINIMAL_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
}

module.exports = nextConfig
`

export const NUXT_MINIMAL_CONFIG = `export default defineNuxtConfig({
  nitro: {
    externals: {
      external: ['better-sqlite3'],
    },
  },
})
`

export type FrameworkExternalsResult =
  | { status: 'written'; path: string }
  | { status: 'updated'; path: string }
  | { status: 'skipped'; path: string }
  | { status: 'manual'; path: string; hint: string }
  | { status: 'noop' }

function findConfig(projectDir: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const path = join(projectDir, name)
    if (existsSync(path)) return path
  }
  return undefined
}

function mentionsBetterSqlite3(content: string): boolean {
  return /['"]better-sqlite3['"]/.test(content)
}

/** Insert `'better-sqlite3'` into an existing `serverExternalPackages: [...]` array. */
export function addToServerExternalPackages(content: string): string | null {
  const re = /serverExternalPackages\s*:\s*\[([^\]]*)\]/
  const match = content.match(re)
  if (!match || match.index === undefined) return null
  const inner = match[1] ?? ''
  if (/['"]better-sqlite3['"]/.test(inner)) return content
  const trimmed = inner.trim()
  const nextInner =
    trimmed.length === 0 ? `'better-sqlite3'` : `${trimmed.replace(/,\s*$/, '')}, 'better-sqlite3'`
  return `${content.slice(0, match.index)}serverExternalPackages: [${nextInner}]${content.slice(match.index + match[0].length)}`
}

/** Insert `'better-sqlite3'` into an existing Nitro `external: [...]` array. */
export function addToNitroExternal(content: string): string | null {
  if (!/\bnitro\s*:/.test(content)) return null
  const re = /\bexternal\s*:\s*\[([^\]]*)\]/
  const match = content.match(re)
  if (!match || match.index === undefined) return null
  const inner = match[1] ?? ''
  if (/['"]better-sqlite3['"]/.test(inner)) return content
  const trimmed = inner.trim()
  const nextInner =
    trimmed.length === 0 ? `'better-sqlite3'` : `${trimmed.replace(/,\s*$/, '')}, 'better-sqlite3'`
  return `${content.slice(0, match.index)}external: [${nextInner}]${content.slice(match.index + match[0].length)}`
}

/**
 * Inject `serverExternalPackages` into common Next starter shapes when the
 * key is absent. Returns null when the file looks too custom to touch.
 */
export function injectNextServerExternalPackages(content: string): string | null {
  if (mentionsBetterSqlite3(content)) return content
  const withArray = addToServerExternalPackages(content)
  if (withArray) return withArray

  const patterns: RegExp[] = [
    /(const\s+nextConfig(?:\s*:\s*[^=]+)?\s*=\s*\{)/,
    /(export\s+default\s*\{)/,
    /(module\.exports\s*=\s*\{)/,
  ]
  for (const re of patterns) {
    if (re.test(content)) {
      return content.replace(re, `$1\n  serverExternalPackages: ['better-sqlite3'],`)
    }
  }
  return null
}

/**
 * Inject Nitro externals into common Nuxt starter shapes when missing.
 * Avoids duplicating a `nitro` key when one already exists.
 */
export function injectNuxtNitroExternal(content: string): string | null {
  if (mentionsBetterSqlite3(content)) return content
  const withExternal = addToNitroExternal(content)
  if (withExternal) return withExternal

  if (/\bnitro\s*:/.test(content)) {
    // nitro present but no `external: [...]` we could extend — too ambiguous.
    return null
  }

  const re = /(defineNuxtConfig\s*\(\s*\{)/
  if (re.test(content)) {
    return content.replace(
      re,
      `$1\n  nitro: {\n    externals: {\n      external: ['better-sqlite3'],\n    },\n  },`,
    )
  }
  return null
}

function writeNew(path: string, content: string): FrameworkExternalsResult {
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`)
  return { status: 'written', path }
}

function updateOrManual(
  path: string,
  original: string,
  next: string | null,
  hint: string,
): FrameworkExternalsResult {
  if (next === null) return { status: 'manual', path, hint }
  if (next === original) return { status: 'skipped', path }
  writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`)
  return { status: 'updated', path }
}

export function ensureNextExternals(projectDir: string): FrameworkExternalsResult {
  const existing = findConfig(projectDir, NEXT_CONFIG_NAMES)
  if (!existing) {
    return writeNew(join(projectDir, 'next.config.js'), NEXT_MINIMAL_CONFIG)
  }
  const original = readFileSync(existing, 'utf8')
  if (mentionsBetterSqlite3(original)) return { status: 'skipped', path: existing }
  return updateOrManual(
    existing,
    original,
    injectNextServerExternalPackages(original),
    NEXT_EXTERNAL_HINT,
  )
}

export function ensureNuxtExternals(projectDir: string): FrameworkExternalsResult {
  const existing = findConfig(projectDir, NUXT_CONFIG_NAMES)
  if (!existing) {
    return writeNew(join(projectDir, 'nuxt.config.ts'), NUXT_MINIMAL_CONFIG)
  }
  const original = readFileSync(existing, 'utf8')
  if (mentionsBetterSqlite3(original)) return { status: 'skipped', path: existing }
  return updateOrManual(existing, original, injectNuxtNitroExternal(original), NUXT_EXTERNAL_HINT)
}

/** Patch or create the framework config that keeps better-sqlite3 unbundled. */
export function ensureFrameworkExternals(
  projectDir: string,
  framework: Framework,
): FrameworkExternalsResult {
  if (framework === 'next') return ensureNextExternals(projectDir)
  if (framework === 'nuxt') return ensureNuxtExternals(projectDir)
  return { status: 'noop' }
}

/**
 * Read-only check used by `cloudconfig doctor`: does the Next/Nuxt config mark
 * `better-sqlite3` external? Does not write files — when init left a
 * `manual` hint, doctor surfaces the same snippet before `dev` fails.
 */
export type FrameworkExternalsInspection =
  | { status: 'ok'; path: string; detail: string }
  | { status: 'warn'; path?: string; hint: string }
  | { status: 'noop' }

export function inspectFrameworkExternals(
  projectDir: string,
  framework: Framework,
): FrameworkExternalsInspection {
  if (framework === 'next') {
    const path = findConfig(projectDir, NEXT_CONFIG_NAMES)
    if (!path) {
      return {
        status: 'warn',
        hint: `No next.config.* found. ${NEXT_EXTERNAL_HINT}`,
      }
    }
    const name = path.slice(projectDir.length).replace(/^[/\\]/, '')
    const content = readFileSync(path, 'utf8')
    if (mentionsBetterSqlite3(content)) {
      return { status: 'ok', path: name, detail: `${name} marks better-sqlite3 external` }
    }
    return { status: 'warn', path: name, hint: NEXT_EXTERNAL_HINT }
  }

  if (framework === 'nuxt') {
    const path = findConfig(projectDir, NUXT_CONFIG_NAMES)
    if (!path) {
      return {
        status: 'warn',
        hint: `No nuxt.config.* found. ${NUXT_EXTERNAL_HINT}`,
      }
    }
    const name = path.slice(projectDir.length).replace(/^[/\\]/, '')
    const content = readFileSync(path, 'utf8')
    if (mentionsBetterSqlite3(content)) {
      return { status: 'ok', path: name, detail: `${name} marks better-sqlite3 external` }
    }
    return { status: 'warn', path: name, hint: NUXT_EXTERNAL_HINT }
  }

  return { status: 'noop' }
}
