/**
 * Covers drizzle-kit detection and install hints for `cloudconfig db generate`.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  drizzleKitGenerateFailedMessage,
  findDrizzleKitCli,
  hasLocalDrizzleKitBin,
  isDrizzleKitInstalled,
  missingDrizzleKitMessage,
} from '../src/cli/drizzle-kit.js'
import { installDevDepCommand } from '../src/cli/package-manager.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('isDrizzleKitInstalled / hasLocalDrizzleKitBin', () => {
  it('returns true when probe succeeds', () => {
    expect(isDrizzleKitInstalled('/any', () => true)).toBe(true)
  })

  it('returns false when probe fails', () => {
    expect(isDrizzleKitInstalled('/any', () => false)).toBe(false)
  })

  it('finds a local node_modules/.bin/drizzle-kit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-drizzle-bin-'))
    dirs.push(dir)
    const binDir = join(dir, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    const bin = join(binDir, 'drizzle-kit')
    writeFileSync(bin, '#!/bin/sh\n')
    chmodSync(bin, 0o755)
    expect(hasLocalDrizzleKitBin(dir)).toBe(true)
    expect(isDrizzleKitInstalled(dir)).toBe(true)
  })

  it('finds drizzle-kit in a parent node_modules/.bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloudconfig-drizzle-parent-'))
    dirs.push(root)
    const binDir = join(root, 'node_modules', '.bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'drizzle-kit'), '#!/bin/sh\n')
    const nested = join(root, 'apps', 'web')
    mkdirSync(nested, { recursive: true })
    expect(hasLocalDrizzleKitBin(nested)).toBe(true)
  })

  it('returns false in a project with no drizzle-kit bin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-no-drizzle-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    expect(hasLocalDrizzleKitBin(dir)).toBe(false)
    expect(isDrizzleKitInstalled(dir)).toBe(false)
  })
})

describe('missingDrizzleKitMessage', () => {
  it('includes a default install line when none is provided', () => {
    const msg = missingDrizzleKitMessage()
    expect(msg).toContain('drizzle-kit')
    expect(msg).toContain('pnpm add -D drizzle-kit')
    expect(msg).toContain('Then re-run this command.')
  })

  it('uses a package-manager-specific install command when provided', () => {
    expect(missingDrizzleKitMessage('npm install -D drizzle-kit')).toContain(
      'Install: npm install -D drizzle-kit',
    )
    expect(missingDrizzleKitMessage(installDevDepCommand('yarn', 'drizzle-kit'))).toContain(
      'Install: yarn add -D drizzle-kit',
    )
  })
})

describe('drizzleKitGenerateFailedMessage', () => {
  it('includes the launch error instead of hiding it behind the generic message', () => {
    expect(drizzleKitGenerateFailedMessage(new Error('spawn failed: EACCES'))).toContain(
      'spawn failed: EACCES',
    )
  })
  it('does not blame a missing install', () => {
    const msg = drizzleKitGenerateFailedMessage()
    expect(msg).toMatch(/failed/i)
    expect(msg).not.toMatch(/installed/i)
    expect(msg).toContain('output above')
  })
})

describe('findDrizzleKitCli', () => {
  it('resolves the real package entry even when only a Windows shell shim exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'cloudconfig-drizzle-entry-'))
    dirs.push(root)
    const packageDir = join(root, 'node_modules', 'drizzle-kit')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ bin: { 'drizzle-kit': './bin.cjs' } }),
    )
    writeFileSync(join(packageDir, 'bin.cjs'), '')
    mkdirSync(join(root, 'node_modules', '.bin'))
    writeFileSync(join(root, 'node_modules', '.bin', 'drizzle-kit.cmd'), '')
    const projectDir = join(root, 'apps', 'web')
    mkdirSync(projectDir, { recursive: true })
    expect(hasLocalDrizzleKitBin(projectDir)).toBe(true)
    expect(findDrizzleKitCli(projectDir)).toBe(join(packageDir, 'bin.cjs'))
  })

  it('rejects a package whose CLI file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-drizzle-broken-'))
    dirs.push(dir)
    const packageDir = join(dir, 'node_modules', 'drizzle-kit')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ bin: './missing.cjs' }))
    expect(findDrizzleKitCli(dir)).toBeUndefined()
  })
})

describe('installDevDepCommand for drizzle-kit', () => {
  it('emits the right flag per package manager', () => {
    expect(installDevDepCommand('pnpm', 'drizzle-kit')).toBe('pnpm add -D drizzle-kit')
    expect(installDevDepCommand('npm', 'drizzle-kit')).toBe('npm install -D drizzle-kit')
    expect(installDevDepCommand('bun', 'drizzle-kit')).toBe('bun add -d drizzle-kit')
  })
})
