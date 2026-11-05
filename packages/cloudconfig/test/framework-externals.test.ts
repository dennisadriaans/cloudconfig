/**
 * Covers Next/Nuxt better-sqlite3 externals: write, inject, skip, and manual hint.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initCommand } from '../src/cli/commands/init.js'
import {
  addToNitroExternal,
  addToServerExternalPackages,
  ensureFrameworkExternals,
  ensureNextExternals,
  ensureNuxtExternals,
  injectNextServerExternalPackages,
  injectNuxtNitroExternal,
  inspectFrameworkExternals,
  NEXT_EXTERNAL_HINT,
  NEXT_MINIMAL_CONFIG,
  NUXT_EXTERNAL_HINT,
  NUXT_MINIMAL_CONFIG,
} from '../src/cli/framework-externals.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudconfig-externals-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('addToServerExternalPackages', () => {
  it('appends to a non-empty array', () => {
    const next = addToServerExternalPackages(`const c = { serverExternalPackages: ['sharp'] }`)
    expect(next).toContain("serverExternalPackages: ['sharp', 'better-sqlite3']")
  })

  it('fills an empty array', () => {
    expect(addToServerExternalPackages(`{ serverExternalPackages: [] }`)).toContain(
      "serverExternalPackages: ['better-sqlite3']",
    )
  })

  it('is a no-op when better-sqlite3 is already listed', () => {
    const src = `{ serverExternalPackages: ['better-sqlite3'] }`
    expect(addToServerExternalPackages(src)).toBe(src)
  })

  it('returns null when the key is absent', () => {
    expect(addToServerExternalPackages(`{ turbopack: {} }`)).toBeNull()
  })
})

describe('addToNitroExternal', () => {
  it('appends inside a nitro block', () => {
    const src = `export default defineNuxtConfig({
  nitro: { externals: { external: ['foo'] } },
})`
    expect(addToNitroExternal(src)).toContain("external: ['foo', 'better-sqlite3']")
  })

  it('returns null without a nitro key', () => {
    expect(addToNitroExternal(`{ external: ['foo'] }`)).toBeNull()
  })
})

describe('injectNextServerExternalPackages', () => {
  it('injects into a create-next-app style const nextConfig', () => {
    const src = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
`
    const next = injectNextServerExternalPackages(src)
    expect(next).toContain("serverExternalPackages: ['better-sqlite3'],")
    expect(next).toContain('/* config options here */')
  })

  it('injects into module.exports object', () => {
    const next = injectNextServerExternalPackages(
      `module.exports = {\n  reactStrictMode: true,\n}\n`,
    )
    expect(next).toContain("serverExternalPackages: ['better-sqlite3'],")
    expect(next).toContain('reactStrictMode: true')
  })

  it('returns null for opaque configs', () => {
    expect(injectNextServerExternalPackages(`module.exports = require('./base')`)).toBeNull()
  })
})

describe('injectNuxtNitroExternal', () => {
  it('injects nitro when defineNuxtConfig has no nitro key', () => {
    const src = `export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
})
`
    const next = injectNuxtNitroExternal(src)
    expect(next).toContain('nitro:')
    expect(next).toContain("external: ['better-sqlite3']")
    expect(next).toContain("compatibilityDate: '2025-07-15'")
  })

  it('returns null when nitro exists without an external array', () => {
    const src = `export default defineNuxtConfig({
  nitro: { preset: 'node-server' },
})
`
    expect(injectNuxtNitroExternal(src)).toBeNull()
  })
})

describe('ensureNextExternals', () => {
  it('writes next.config.js when absent', () => {
    const result = ensureNextExternals(dir)
    expect(result).toMatchObject({ status: 'written' })
    expect(readFileSync(join(dir, 'next.config.js'), 'utf8')).toBe(NEXT_MINIMAL_CONFIG)
  })

  it('skips when better-sqlite3 is already configured', () => {
    writeFileSync(
      join(dir, 'next.config.ts'),
      `const nextConfig = { serverExternalPackages: ['better-sqlite3'] }\nexport default nextConfig\n`,
    )
    expect(ensureNextExternals(dir).status).toBe('skipped')
  })

  it('updates a create-next-app starter', () => {
    writeFileSync(
      join(dir, 'next.config.ts'),
      `const nextConfig = {\n  /* config options here */\n}\nexport default nextConfig\n`,
    )
    const result = ensureNextExternals(dir)
    expect(result.status).toBe('updated')
    expect(readFileSync(join(dir, 'next.config.ts'), 'utf8')).toContain(
      "serverExternalPackages: ['better-sqlite3']",
    )
  })

  it('returns a manual hint for opaque configs', () => {
    writeFileSync(join(dir, 'next.config.mjs'), `export default await import('./base.mjs')\n`)
    const result = ensureNextExternals(dir)
    expect(result).toEqual({
      status: 'manual',
      path: join(dir, 'next.config.mjs'),
      hint: NEXT_EXTERNAL_HINT,
    })
  })
})

describe('ensureNuxtExternals', () => {
  it('writes nuxt.config.ts when absent', () => {
    const result = ensureNuxtExternals(dir)
    expect(result).toMatchObject({ status: 'written' })
    expect(readFileSync(join(dir, 'nuxt.config.ts'), 'utf8')).toBe(NUXT_MINIMAL_CONFIG)
  })

  it('updates a bare defineNuxtConfig starter', () => {
    writeFileSync(
      join(dir, 'nuxt.config.ts'),
      `export default defineNuxtConfig({\n  devtools: { enabled: true },\n})\n`,
    )
    expect(ensureNuxtExternals(dir).status).toBe('updated')
    expect(readFileSync(join(dir, 'nuxt.config.ts'), 'utf8')).toContain(
      "external: ['better-sqlite3']",
    )
  })

  it('returns a manual hint when nitro exists without external', () => {
    writeFileSync(
      join(dir, 'nuxt.config.ts'),
      `export default defineNuxtConfig({\n  nitro: { preset: 'node-server' },\n})\n`,
    )
    expect(ensureNuxtExternals(dir)).toEqual({
      status: 'manual',
      path: join(dir, 'nuxt.config.ts'),
      hint: NUXT_EXTERNAL_HINT,
    })
  })
})

describe('ensureFrameworkExternals', () => {
  it('is a noop for standalone', () => {
    expect(ensureFrameworkExternals(dir, 'standalone')).toEqual({ status: 'noop' })
  })
})

describe('cloudconfig init wires framework externals', () => {
  it('writes next.config.js for a Next project without one', () => {
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'my-next', dependencies: { next: '^15' } }, null, 2)}\n`,
    )
    initCommand(dir)
    expect(readFileSync(join(dir, 'next.config.js'), 'utf8')).toContain('better-sqlite3')
  })

  it('patches an existing Next starter config', () => {
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'my-next', dependencies: { next: '^15' } }, null, 2)}\n`,
    )
    writeFileSync(
      join(dir, 'next.config.js'),
      `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n}\nmodule.exports = nextConfig\n`,
    )
    initCommand(dir)
    expect(readFileSync(join(dir, 'next.config.js'), 'utf8')).toContain(
      "serverExternalPackages: ['better-sqlite3']",
    )
  })

  it('writes nuxt.config.ts registering the module for a Nuxt project without one', () => {
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'my-nuxt', dependencies: { nuxt: '^4' } }, null, 2)}\n`,
    )
    initCommand(dir)
    // The module sets the nitro externals itself, so the config only names it.
    expect(readFileSync(join(dir, 'nuxt.config.ts'), 'utf8')).toContain("'@cloudconfig/nuxt'")
  })

  it('is idempotent when externals are already present', () => {
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'my-next', dependencies: { next: '^15' } }, null, 2)}\n`,
    )
    writeFileSync(join(dir, 'next.config.js'), NEXT_MINIMAL_CONFIG)
    initCommand(dir)
    const first = readFileSync(join(dir, 'next.config.js'), 'utf8')
    initCommand(dir)
    expect(readFileSync(join(dir, 'next.config.js'), 'utf8')).toBe(first)
  })
})

describe('inspectFrameworkExternals', () => {
  it('is a noop for standalone', () => {
    expect(inspectFrameworkExternals(dir, 'standalone')).toEqual({ status: 'noop' })
  })

  it('warns when Next config is missing', () => {
    const result = inspectFrameworkExternals(dir, 'next')
    expect(result).toEqual({
      status: 'warn',
      hint: `No next.config.* found. ${NEXT_EXTERNAL_HINT}`,
    })
  })

  it('warns when Next config omits better-sqlite3', () => {
    writeFileSync(join(dir, 'next.config.js'), `module.exports = { reactStrictMode: true }\n`)
    const result = inspectFrameworkExternals(dir, 'next')
    expect(result).toEqual({
      status: 'warn',
      path: 'next.config.js',
      hint: NEXT_EXTERNAL_HINT,
    })
  })

  it('oks when Next config lists better-sqlite3', () => {
    writeFileSync(join(dir, 'next.config.js'), NEXT_MINIMAL_CONFIG)
    const result = inspectFrameworkExternals(dir, 'next')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.path).toBe('next.config.js')
      expect(result.detail).toMatch(/better-sqlite3/)
    }
  })

  it('warns when Nuxt config omits better-sqlite3', () => {
    writeFileSync(join(dir, 'nuxt.config.ts'), `export default defineNuxtConfig({})\n`)
    const result = inspectFrameworkExternals(dir, 'nuxt')
    expect(result).toEqual({
      status: 'warn',
      path: 'nuxt.config.ts',
      hint: NUXT_EXTERNAL_HINT,
    })
  })

  it('oks when Nuxt config lists better-sqlite3', () => {
    writeFileSync(join(dir, 'nuxt.config.ts'), NUXT_MINIMAL_CONFIG)
    expect(inspectFrameworkExternals(dir, 'nuxt').status).toBe('ok')
  })
})
