/**
 * Register `@cloudconfig/nuxt` in a project's Nuxt config.
 *
 * A Nuxt project no longer gets a hand-written catch-all route: the module owns
 * mounting, per-request binding resolution and the client composable. Same
 * conservative strategy as `framework-externals`: write a config when none
 * exists, extend a `modules: [...]` array when one is there, otherwise hand back
 * a hint rather than rewriting a config we cannot parse.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const NUXT_MODULE_NAME = '@cloudconfig/nuxt'
export const NUXT_UI_MODULE_NAME = '@nuxt/ui'

const NUXT_CONFIG_NAMES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'] as const

export const NUXT_MODULE_HINT = `Add modules: ['${NUXT_MODULE_NAME}'] to your Nuxt config.`

export const NUXT_MODULE_CONFIG = `export default defineNuxtConfig({
  modules: ['${NUXT_MODULE_NAME}'],
})
`

export type NuxtModuleResult =
  | { status: 'written'; path: string }
  | { status: 'updated'; path: string }
  | { status: 'skipped'; path: string }
  | { status: 'manual'; path: string; hint: string }

function findConfig(projectDir: string): string | undefined {
  for (const name of NUXT_CONFIG_NAMES) {
    const path = join(projectDir, name)
    if (existsSync(path)) return path
  }
  return undefined
}

function declaresModule(content: string, moduleName = NUXT_MODULE_NAME): boolean {
  return content.includes(`'${moduleName}'`) || content.includes(`"${moduleName}"`)
}

/**
 * Scan past strings, template literals and comments.
 *
 * A `modules` array is edited by splicing text, and a config is real source:
 * `modules: [['some-module', options]]` and a `']'` inside a string both break
 * a regex that stops at the first bracket, and the module ends up nested inside
 * someone else's tuple.
 */
interface KeyPosition {
  /** Index of the first character of the value. */
  valueStart: number
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char)
}

/** Skip the literal starting at `i` (string, template or comment). Returns the next index, or -1. */
function skipLiteral(text: string, i: number): number {
  const char = text[i]
  if (char === '/' && text[i + 1] === '/') {
    const nl = text.indexOf('\n', i)
    return nl === -1 ? text.length : nl
  }
  if (char === '/' && text[i + 1] === '*') {
    const close = text.indexOf('*/', i + 2)
    return close === -1 ? text.length : close + 2
  }
  if (char === "'" || char === '"' || char === '`') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') {
        j++
        continue
      }
      if (text[j] === char) return j + 1
    }
    return -1
  }
  return -1
}

/** The `{` of the config object literal: `defineNuxtConfig({ … })`, or a bare default export. */
function configObjectStart(text: string): number {
  const call = /defineNuxtConfig\s*\(\s*\{/.exec(text)
  if (call) return call.index + call[0].length - 1
  const bare = /export\s+default\s*\{/.exec(text)
  return bare ? bare.index + bare[0].length - 1 : -1
}

/**
 * Position of the config's own `modules:` value.
 *
 * Depth-tracked, so a `modules` key nested in another option (`vite`, `nitro`)
 * is not mistaken for the one Nuxt reads.
 */
function findModulesValue(text: string, property = 'modules'): KeyPosition | null {
  const objectStart = configObjectStart(text)
  if (objectStart === -1) return null

  let depth = 0
  for (let i = objectStart; i < text.length; i++) {
    const literalEnd = skipLiteral(text, i)
    let keyEnd: number

    if (literalEnd !== -1) {
      if (literalEnd <= i) return null
      if (
        depth !== 1 ||
        ![JSON.stringify(property), `'${property}'`].includes(text.slice(i, literalEnd))
      ) {
        i = literalEnd - 1
        continue
      }
      keyEnd = literalEnd
    } else {
      const char = text[i] as string
      if (char === '{' || char === '[' || char === '(') {
        depth++
        continue
      }
      if (char === '}' || char === ']' || char === ')') {
        depth--
        if (depth === 0) return null
        continue
      }
      if (depth !== 1 || !text.startsWith(property, i)) continue
      keyEnd = i + property.length
      if (isIdentifierChar(text[i - 1]) || isIdentifierChar(text[keyEnd])) continue
    }

    let j = keyEnd
    while (j < text.length && /\s/.test(text[j] as string)) j++
    if (text[j] !== ':') {
      i = keyEnd - 1
      continue
    }
    j++
    while (j < text.length && /\s/.test(text[j] as string)) j++
    return { valueStart: j }
  }
  return null
}

/** Index of the `]` closing the array that opens at `open`, or -1 when unbalanced. */
function findArrayEnd(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const skipped = skipLiteral(text, i)
    if (skipped !== -1) {
      if (skipped <= i) return -1
      i = skipped - 1
      continue
    }
    const char = text[i]
    if (char === '[' || char === '{' || char === '(') depth++
    else if (char === '}' || char === ')') depth--
    else if (char === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Add the module to an existing `modules: [...]` array.
 *
 * Returns null when `modules` is not an array literal (a variable, a spread of
 * one) — that config is edited by hand rather than guessed at.
 */
export function addToModulesArray(content: string, moduleName = NUXT_MODULE_NAME): string | null {
  const key = findModulesValue(content)
  if (!key || content[key.valueStart] !== '[') return null
  const close = findArrayEnd(content, key.valueStart)
  if (close === -1) return null

  const inner = content.slice(key.valueStart + 1, close)
  const nextInner = `'${moduleName}', ${inner}`

  return `${content.slice(0, key.valueStart + 1)}${nextInner}${content.slice(close)}`
}

/** Inject a `modules` key into a `defineNuxtConfig({ … })` call that lacks one. */
export function injectNuxtModule(content: string, moduleName = NUXT_MODULE_NAME): string | null {
  if (declaresModule(content, moduleName)) return content
  const withArray = addToModulesArray(content, moduleName)
  if (withArray) return withArray
  // A `modules` key we could not extend must never get a second one next to it.
  if (findModulesValue(content)) return null

  const re = /(defineNuxtConfig\s*\(\s*\{)/
  if (re.test(content)) {
    return content.replace(re, `$1\n  modules: ['${moduleName}'],`)
  }
  return null
}

export function ensureNuxtModule(projectDir: string): NuxtModuleResult {
  const existing = findConfig(projectDir)
  if (!existing) {
    const path = join(projectDir, 'nuxt.config.ts')
    writeFileSync(path, NUXT_MODULE_CONFIG)
    return { status: 'written', path }
  }
  const original = readFileSync(existing, 'utf8')
  if (declaresModule(original)) return { status: 'skipped', path: existing }
  const next = injectNuxtModule(original)
  if (next === null) return { status: 'manual', path: existing, hint: NUXT_MODULE_HINT }
  writeFileSync(existing, next.endsWith('\n') ? next : `${next}\n`)
  return { status: 'updated', path: existing }
}

/** Register a second, known Nuxt module using the same conservative parser. */
export function ensureNuxtUiModule(projectDir: string): NuxtModuleResult {
  const existing = findConfig(projectDir)
  const hint = `Add modules: ['${NUXT_UI_MODULE_NAME}'] to your Nuxt config.`
  if (!existing) {
    const path = join(projectDir, 'nuxt.config.ts')
    writeFileSync(
      path,
      `export default defineNuxtConfig({\n  modules: ['${NUXT_UI_MODULE_NAME}'],\n})\n`,
    )
    return { status: 'written', path }
  }
  const original = readFileSync(existing, 'utf8')
  if (declaresModule(original, NUXT_UI_MODULE_NAME)) return { status: 'skipped', path: existing }
  const next = injectNuxtModule(original, NUXT_UI_MODULE_NAME)
  if (next === null) return { status: 'manual', path: existing, hint }
  writeFileSync(existing, next.endsWith('\n') ? next : `${next}\n`)
  return { status: 'updated', path: existing }
}

/** Enable the module's deterministic Workers build settings without replacing host config. */
export function ensureNuxtCloudflare(projectDir: string): void {
  const path = findConfig(projectDir)
  if (!path) throw new Error('Nuxt config is missing. Run cloudconfig init --target nuxt first.')
  const content = readFileSync(path, 'utf8')
  const key = findModulesValue(content, 'cloudconfig')
  let next: string
  if (!key) {
    if (!/defineNuxtConfig\s*\(\s*\{/.test(content)) {
      throw new Error('Add cloudconfig: { cloudflare: true } to your Nuxt config, then rerun init.')
    }
    next = content.replace(
      /(defineNuxtConfig\s*\(\s*\{)/,
      '$1\n  cloudconfig: { cloudflare: true },',
    )
  } else {
    if (content[key.valueStart] !== '{') {
      throw new Error(
        'Set cloudflare: true in your existing cloudconfig module options, then rerun init.',
      )
    }
    const fragment = `defineNuxtConfig(${content.slice(key.valueStart)}`
    const option = findModulesValue(fragment, 'cloudflare')
    if (option) {
      if (/^true\s*[,}]/.test(fragment.slice(option.valueStart))) return
      throw new Error(
        'Existing cloudconfig.cloudflare is not true. Set it to true explicitly before Cloudflare setup.',
      )
    }
    next =
      content.slice(0, key.valueStart + 1) +
      '\n    cloudflare: true,' +
      content.slice(key.valueStart + 1)
  }
  writeFileSync(path, next)
}

/** Read-only check for `cloudconfig doctor`. */
export function inspectNuxtModule(projectDir: string): NuxtModuleResult | { status: 'missing' } {
  const existing = findConfig(projectDir)
  if (!existing) return { status: 'missing' }
  const content = readFileSync(existing, 'utf8')
  if (declaresModule(content)) return { status: 'skipped', path: existing }
  return { status: 'manual', path: existing, hint: NUXT_MODULE_HINT }
}
