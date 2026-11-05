/**
 * Covers wrangler detection and install hints for `cloudconfig db migrate` (D1 path).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasLocalWranglerBin,
  hasWranglerConfig,
  isWranglerInstalled,
  missingWranglerMessage,
  wranglerMigrateFailedMessage,
} from '../src/cli/wrangler.js'
import { installDevDepCommand } from '../src/cli/package-manager.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('hasWranglerConfig', () => {
  it('detects wrangler.toml, .json, and .jsonc', () => {
    for (const name of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-wrangler-cfg-'))
      dirs.push(dir)
      writeFileSync(join(dir, name), name.endsWith('.toml') ? 'name = "app"' : '{}')
      expect(hasWranglerConfig(dir)).toBe(true)
    }
  })

  it('returns false when no wrangler config exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-no-wrangler-cfg-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    expect(hasWranglerConfig(dir)).toBe(false)
  })
})

describe('isWranglerInstalled / hasLocalWranglerBin', () => {
  it('returns true when probe succeeds', () => {
    expect(isWranglerInstalled('/any', () => true)).toBe(true)
  })

  it('returns false when probe fails', () => {
    expect(isWranglerInstalled('/any', () => false)).toBe(false)
  })

  it('finds a local node_modules/.bin/wrangler', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-wrangler-bin-'))
    dirs.push(dir)
    const binDir = join(dir, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const bin = join(binDir, 'wrangler')
    writeFileSync(bin, '#!/bin/sh\n')
    chmodSync(bin, 0o755)
    expect(hasLocalWranglerBin(dir)).toBe(true)
    expect(isWranglerInstalled(dir)).toBe(true)
  })

  it('finds wrangler in a parent node_modules/.bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloudconfig-wrangler-parent-'))
    dirs.push(root)
    const binDir = join(root, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'wrangler'), '#!/bin/sh\n')
    const nested = join(root, 'apps', 'web')
    mkdirSync(nested, { recursive: true })
    expect(hasLocalWranglerBin(nested)).toBe(true)
  })

  it('returns false in a project with no wrangler bin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-no-wrangler-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    expect(hasLocalWranglerBin(dir)).toBe(false)
    expect(isWranglerInstalled(dir)).toBe(false)
  })
})

describe('missingWranglerMessage', () => {
  it('includes a default install line when none is provided', () => {
    const msg = missingWranglerMessage()
    expect(msg).toContain('wrangler')
    expect(msg).toContain('pnpm add -D wrangler')
    expect(msg).toContain('local SQLite')
    expect(msg).toContain('Then re-run this command.')
  })

  it('uses a package-manager-specific install command when provided', () => {
    expect(missingWranglerMessage('npm install -D wrangler')).toContain(
      'Install: npm install -D wrangler',
    )
    expect(missingWranglerMessage(installDevDepCommand('yarn', 'wrangler'))).toContain(
      'Install: yarn add -D wrangler',
    )
  })
})

describe('wranglerMigrateFailedMessage', () => {
  it('does not blame a missing install', () => {
    const msg = wranglerMigrateFailedMessage()
    expect(msg).toMatch(/failed/i)
    expect(msg).not.toMatch(/installed/i)
    expect(msg).toContain('output above')
  })
})

describe('installDevDepCommand for wrangler', () => {
  it('emits the right flag per package manager', () => {
    expect(installDevDepCommand('pnpm', 'wrangler')).toBe('pnpm add -D wrangler')
    expect(installDevDepCommand('npm', 'wrangler')).toBe('npm install -D wrangler')
    expect(installDevDepCommand('bun', 'wrangler')).toBe('bun add -d wrangler')
  })
})
