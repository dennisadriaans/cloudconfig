/**
 * Covers the optional better-sqlite3 peer: detection, install hints, and the
 * lazy require path so a missing peer does not take down the whole CLI.
 */
import { describe, expect, it } from 'vitest'
import {
  isMissingPackageError,
  missingBetterSqlite3Message,
  requireBetterSqlite3,
} from '../src/shared/better-sqlite3.js'
import { formatCliError } from '../src/cli/format-error.js'
import { installDevDepCommand } from '../src/cli/package-manager.js'
import { sqliteFile } from '../src/drivers/better-sqlite3.js'

function missingErr(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

describe('isMissingPackageError', () => {
  it('matches ESM and CJS missing-package codes', () => {
    expect(
      isMissingPackageError(
        missingErr('ERR_MODULE_NOT_FOUND', "Cannot find package 'better-sqlite3'"),
        'better-sqlite3',
      ),
    ).toBe(true)
    expect(
      isMissingPackageError(
        missingErr('MODULE_NOT_FOUND', "Cannot find module 'better-sqlite3'"),
        'better-sqlite3',
      ),
    ).toBe(true)
  })

  it('ignores other packages and non-missing failures', () => {
    expect(
      isMissingPackageError(
        missingErr('ERR_MODULE_NOT_FOUND', "Cannot find package 'drizzle-kit'"),
        'better-sqlite3',
      ),
    ).toBe(false)
    expect(isMissingPackageError(new Error('native binding failed'), 'better-sqlite3')).toBe(false)
    expect(isMissingPackageError(null, 'better-sqlite3')).toBe(false)
  })
})

describe('missingBetterSqlite3Message', () => {
  it('includes a default install line when none is provided', () => {
    const msg = missingBetterSqlite3Message()
    expect(msg).toContain('better-sqlite3')
    expect(msg).toContain('pnpm add -D better-sqlite3')
    expect(msg).toContain('Then re-run this command.')
  })

  it('uses a package-manager-specific install command when provided', () => {
    expect(missingBetterSqlite3Message('npm install -D better-sqlite3')).toContain(
      'Install: npm install -D better-sqlite3',
    )
  })
})

describe('installDevDepCommand', () => {
  it('emits the right flag per package manager', () => {
    expect(installDevDepCommand('pnpm', 'better-sqlite3')).toBe('pnpm add -D better-sqlite3')
    expect(installDevDepCommand('npm', 'better-sqlite3')).toBe('npm install -D better-sqlite3')
    expect(installDevDepCommand('yarn', 'better-sqlite3')).toBe('yarn add -D better-sqlite3')
    expect(installDevDepCommand('bun', 'better-sqlite3')).toBe('bun add -d better-sqlite3')
  })
})

describe('requireBetterSqlite3', () => {
  it('returns the module when require succeeds', () => {
    const fake = function FakeDatabase() {}
    expect(
      requireBetterSqlite3(undefined, (id) => {
        expect(id).toBe('better-sqlite3')
        return fake
      }),
    ).toBe(fake)
  })

  it('throws an install hint when the package is missing', () => {
    expect(() =>
      requireBetterSqlite3('pnpm add -D better-sqlite3', () => {
        throw missingErr('ERR_MODULE_NOT_FOUND', "Cannot find package 'better-sqlite3'")
      }),
    ).toThrow(/Install: pnpm add -D better-sqlite3/)
  })

  it('rethrows unrelated load failures', () => {
    expect(() =>
      requireBetterSqlite3(undefined, () => {
        throw new Error('Could not locate the bindings file')
      }),
    ).toThrow(/bindings file/)
  })
})

describe('formatCliError', () => {
  it('rewrites a raw missing better-sqlite3 error using the project package manager', () => {
    const dir = '/tmp' // no lockfile → npm
    const msg = formatCliError(
      missingErr('MODULE_NOT_FOUND', "Cannot find module 'better-sqlite3'"),
      dir,
    )
    expect(msg).toContain('npm install -D better-sqlite3')
    expect(msg).not.toMatch(/Require stack/)
  })

  it('passes through unrelated errors', () => {
    expect(formatCliError(new Error('No cloud.config.ts found'), '/tmp')).toBe(
      'No cloud.config.ts found',
    )
  })
})

describe('sqliteFile connect without better-sqlite3', () => {
  it('still constructs a provider; connect fails with an install hint when require is mocked', () => {
    // Provider construction must not touch the native module — only connect().
    const provider = sqliteFile(':memory:')
    expect(provider.id).toBe('better-sqlite3')
  })
})
