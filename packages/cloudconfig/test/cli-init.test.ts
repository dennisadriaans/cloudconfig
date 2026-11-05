/**
 * Covers the `cloudconfig init` scaffolding contract: the MCP server key derived from
 * `package.json`, the package-manager-aware runner, and idempotency.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initCommand } from '../src/cli/commands/init.js'
import {
  detectPackageManager,
  installCommand,
  runScriptCommand,
  runnerFor,
} from '../src/cli/package-manager.js'
import { packageNameFor, sanitizeMcpName } from '../src/cli/package-name.js'
import { mcpConfigFor } from '../src/cli/scaffold.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudconfig-init-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writePkg(pkg: unknown, at: string = dir): void {
  writeFileSync(join(at, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

function readMcpServers(at: string = dir): Record<string, { command: string; args: string[] }> {
  const parsed = JSON.parse(readFileSync(join(at, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[] }>
  }
  return parsed.mcpServers
}

describe('sanitizeMcpName', () => {
  it('strips the npm scope', () => {
    expect(sanitizeMcpName('@cloudconfig-examples/next')).toBe('next')
  })

  it('passes through an already-safe name', () => {
    expect(sanitizeMcpName('my-app')).toBe('my-app')
  })

  it('replaces characters hosts reject in tool names', () => {
    expect(sanitizeMcpName('My.App v2')).toBe('my-app-v2')
  })

  it('trims leading and trailing separators', () => {
    expect(sanitizeMcpName('@acme/--weird--')).toBe('weird')
  })

  it('falls back when a name sanitizes down to nothing', () => {
    expect(sanitizeMcpName('@acme/~~~')).toBe('cloudconfig')
  })
})

describe('packageNameFor', () => {
  /** The key must name the user's project, so the fallback is the directory. */
  const dirName = (): string => sanitizeMcpName(basename(dir))

  it('falls back to the directory name when package.json is absent', () => {
    expect(packageNameFor(dir)).toBe(dirName())
  })

  it('falls back to the directory name when package.json is malformed', () => {
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(packageNameFor(dir)).toBe(dirName())
  })

  it('falls back to the directory name when the name field is missing or blank', () => {
    writePkg({ private: true })
    expect(packageNameFor(dir)).toBe(dirName())
    writePkg({ name: '   ' })
    expect(packageNameFor(dir)).toBe(dirName())
  })

  it('never yields the framework name for a normally-named directory', () => {
    expect(packageNameFor(dir)).not.toBe('cloudconfig')
  })

  it('sanitizes a scoped name', () => {
    writePkg({ name: '@acme/My.App' })
    expect(packageNameFor(dir)).toBe('my-app')
  })
})

describe('detectPackageManager', () => {
  it('defaults to npm with no signals', () => {
    expect(detectPackageManager(dir)).toBe('npm')
  })

  it('reads the packageManager field', () => {
    writePkg({ name: 'x', packageManager: 'pnpm@10.32.1' })
    expect(detectPackageManager(dir)).toBe('pnpm')
  })

  it('detects each lockfile', () => {
    const cases: Array<[string, string]> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['package-lock.json', 'npm'],
    ]
    for (const [file, expected] of cases) {
      const sub = mkdtempSync(join(tmpdir(), 'cloudconfig-pm-'))
      writeFileSync(join(sub, file), '')
      expect(detectPackageManager(sub)).toBe(expected)
      rmSync(sub, { recursive: true, force: true })
    }
  })

  it('finds a workspace lockfile above the project directory', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    const nested = join(dir, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    expect(detectPackageManager(nested)).toBe('pnpm')
  })
})

describe('runnerFor', () => {
  it('resolves local bins per package manager', () => {
    expect(runnerFor('pnpm', 'cloudconfig', ['mcp'])).toEqual({
      command: 'pnpm',
      args: ['exec', 'cloudconfig', 'mcp'],
    })
    expect(runnerFor('npm', 'cloudconfig', ['mcp'])).toEqual({
      command: 'npx',
      args: ['cloudconfig', 'mcp'],
    })
    expect(runnerFor('bun', 'cloudconfig', ['mcp'])).toEqual({
      command: 'bunx',
      args: ['cloudconfig', 'mcp'],
    })
    expect(runnerFor('yarn', 'cloudconfig', ['mcp'])).toEqual({
      command: 'yarn',
      args: ['cloudconfig', 'mcp'],
    })
  })
})

describe('installCommand / runScriptCommand', () => {
  it('formats install and script runners per package manager', () => {
    expect(installCommand('pnpm')).toBe('pnpm install')
    expect(installCommand('npm')).toBe('npm install')
    expect(installCommand('yarn')).toBe('yarn')
    expect(installCommand('bun')).toBe('bun install')
    expect(runScriptCommand('pnpm', 'db:generate')).toBe('pnpm db:generate')
    expect(runScriptCommand('npm', 'db:generate')).toBe('npm run db:generate')
    expect(runScriptCommand('yarn', 'dev')).toBe('yarn dev')
    expect(runScriptCommand('bun', 'mcp')).toBe('bun run mcp')
  })
})

describe('mcpConfigFor', () => {
  it('sanitizes the key and emits the given runner', () => {
    const json = mcpConfigFor('@acme/My.App', {
      command: 'pnpm',
      args: ['exec', 'cloudconfig', 'mcp'],
    })
    expect(JSON.parse(json)).toEqual({
      mcpServers: { 'my-app': { command: 'pnpm', args: ['exec', 'cloudconfig', 'mcp'] } },
    })
  })

  it('ends with a trailing newline', () => {
    expect(
      mcpConfigFor('app', { command: 'npx', args: ['cloudconfig', 'mcp'] }).endsWith('}\n'),
    ).toBe(true)
  })
})

describe('initCommand', () => {
  it.each(['nuxt', 'next', 'standalone'] as const)(
    'preserves a legacy config when initializing %s',
    (target) => {
      const source = 'export default { models: {} }\n'
      writeFileSync(join(dir, 'cloudconfig.config.ts'), source)
      initCommand(dir, { target })
      expect(existsSync(join(dir, 'cloud.config.ts'))).toBe(false)
      expect(readFileSync(join(dir, 'cloudconfig.config.ts'), 'utf8')).toBe(source)
      if (target === 'standalone') {
        expect(readFileSync(join(dir, 'server.ts'), 'utf8')).toContain('./cloudconfig.config.ts')
        expect(readFileSync(join(dir, 'worker.ts'), 'utf8')).toContain('./cloudconfig.config')
      } else if (target === 'next') {
        expect(readFileSync(join(dir, 'app/api/[[...cloudconfig]]/route.ts'), 'utf8')).toContain(
          '@/cloudconfig.config',
        )
      }
    },
  )

  it('writes a .mcp.json keyed by the sanitized package name', () => {
    writePkg({ name: '@acme/my-app', packageManager: 'pnpm@10.0.0' })
    initCommand(dir)

    const servers = readMcpServers()
    expect(Object.keys(servers)).toEqual(['my-app'])
    expect(servers['my-app']).toEqual({ command: 'pnpm', args: ['exec', 'cloudconfig', 'mcp'] })
  })

  it('falls back to npx when no package manager is detectable', () => {
    // A bare package.json with no lockfile and no packageManager field.
    writePkg({ name: 'plain-app' })
    initCommand(dir)

    expect(readMcpServers()['plain-app']).toEqual({ command: 'npx', args: ['cloudconfig', 'mcp'] })
  })

  it('keys standalone projects off the package.json it generates', () => {
    // No package.json: init writes one (name `my-cloudconfig-app`) before the
    // MCP config, so the key must follow that name rather than the fallback.
    initCommand(dir)
    expect(Object.keys(readMcpServers())).toEqual(['my-cloudconfig-app'])
  })

  it('scaffolds a standalone auth backend without an admin panel', () => {
    initCommand(dir, { target: 'standalone', template: 'dashboard' })

    expect(existsSync(join(dir, 'dashboard'))).toBe(false)
    expect(readFileSync(join(dir, 'cloud.config.ts'), 'utf8')).toContain(
      'providers: { github: true }',
    )
    const server = readFileSync(join(dir, 'server.ts'), 'utf8')
    expect(server).toContain('createBackend(config,')
    expect(server).not.toContain('/admin')
    expect(server).not.toContain('dashboard/')
  })

  it('never overwrites an existing .mcp.json', () => {
    writePkg({ name: 'my-app' })
    const custom = `${JSON.stringify({ mcpServers: { legacy: { command: 'cloudconfig' } } }, null, 2)}\n`
    writeFileSync(join(dir, '.mcp.json'), custom)

    initCommand(dir)

    expect(readFileSync(join(dir, '.mcp.json'), 'utf8')).toBe(custom)
  })

  it('is idempotent across repeated runs', () => {
    writePkg({ name: 'my-app', packageManager: 'pnpm@10.0.0' })
    initCommand(dir)
    const first = readFileSync(join(dir, '.mcp.json'), 'utf8')
    initCommand(dir)
    expect(readFileSync(join(dir, '.mcp.json'), 'utf8')).toBe(first)
  })

  it('registers the Nuxt module instead of writing a catch-all route', () => {
    writePkg({ name: 'my-nuxt', dependencies: { nuxt: '^4' } })
    initCommand(dir)

    expect(existsSync(join(dir, 'server/api/[...].ts'))).toBe(false)
    expect(readFileSync(join(dir, 'nuxt.config.ts'), 'utf8')).toContain("'@cloudconfig/nuxt'")

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['@cloudconfig/nuxt']).toBeDefined()
  })

  it('always writes a server folder for Nuxt, without the dashboard template', () => {
    writePkg({ name: 'my-nuxt', dependencies: { nuxt: '^4' } })
    initCommand(dir)

    const readme = readFileSync(join(dir, 'server/README.md'), 'utf8')
    expect(readme).toContain('cloud.config.ts')
    expect(readme).toContain('server/api/')

    const health = readFileSync(join(dir, 'server/api/health.ts'), 'utf8')
    expect(health).toContain('defineEventHandler')
  })

  it('leaves an existing server folder file alone', () => {
    writePkg({ name: 'my-nuxt', dependencies: { nuxt: '^4' } })
    mkdirSync(join(dir, 'server/api'), { recursive: true })
    writeFileSync(join(dir, 'server/api/health.ts'), 'export default 1\n')

    initCommand(dir)

    expect(readFileSync(join(dir, 'server/api/health.ts'), 'utf8')).toBe('export default 1\n')
  })

  it('scaffolds a Next.js mount with a database adapter selected from the config', () => {
    writePkg({ name: 'my-next', dependencies: { next: '^15' } })
    initCommand(dir)

    const mount = readFileSync(join(dir, 'app/api/[[...cloudconfig]]/route.ts'), 'utf8')
    expect(mount).toContain("from '@cloudconfig/core/drivers/configured'")
    expect(mount).toContain('configuredDatabase(config)')
    expect(mount).toContain('createBackend(config, { db: configuredDatabase(config) })')
  })

  it('treats an unsupported framework as standalone rather than guessing a mount', () => {
    // init scaffolds Nuxt, Next and standalone. Anything else gets the
    // standalone server it can actually run, not a mount file for a router
    // shape CloudConfig no longer generates.
    writePkg({ name: 'my-svelte', dependencies: { '@sveltejs/kit': '^2' } })
    initCommand(dir)

    expect(existsSync(join(dir, 'src/routes/api/[...cloudconfig]/+server.ts'))).toBe(false)
    const entry = readFileSync(join(dir, 'server.ts'), 'utf8')
    expect(entry).toContain("from '@cloudconfig/core/drivers/configured'")
    expect(entry).toContain('createBackend(config, { db: configuredDatabase(')
  })

  it('merges CloudConfig scripts and local sqlite deps into a Nuxt package.json', () => {
    writePkg({
      name: 'my-nuxt',
      scripts: { dev: 'nuxt dev', build: 'nuxt build' },
      dependencies: { nuxt: '^4' },
      packageManager: 'pnpm@10.0.0',
    })
    initCommand(dir)

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.scripts).toMatchObject({
      dev: 'nuxt dev',
      build: 'nuxt build',
      'db:generate': 'cloudconfig db generate',
      'db:migrate': 'cloudconfig db migrate',
      'db:status': 'cloudconfig db status',
      doctor: 'cloudconfig doctor',
      mcp: 'cloudconfig mcp',
    })
    expect(pkg.devDependencies['better-sqlite3']).toBe('^12.0.0')
    expect(pkg.devDependencies['drizzle-kit']).toBe('^0.31.0')
  })

  it('merges CloudConfig scripts and local sqlite deps into a Next package.json', () => {
    writePkg({
      name: 'my-next',
      scripts: { dev: 'next dev' },
      dependencies: { next: '^15' },
    })
    initCommand(dir)

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.scripts.dev).toBe('next dev')
    expect(pkg.scripts['db:generate']).toBe('cloudconfig db generate')
    expect(pkg.scripts['db:migrate']).toBe('cloudconfig db migrate')
    expect(pkg.scripts['db:status']).toBe('cloudconfig db status')
    expect(pkg.scripts.doctor).toBe('cloudconfig doctor')
    expect(pkg.scripts.mcp).toBe('cloudconfig mcp')
    expect(pkg.devDependencies['better-sqlite3']).toBeDefined()
    expect(pkg.devDependencies['drizzle-kit']).toBeDefined()
  })

  it('does not overwrite existing scripts or dependency versions', () => {
    writePkg({
      name: 'my-next',
      scripts: {
        dev: 'next dev',
        'db:generate': 'echo custom-generate',
        mcp: 'echo custom-mcp',
        doctor: 'echo custom-doctor',
      },
      dependencies: { next: '^15', 'better-sqlite3': '^11.0.0' },
      devDependencies: { 'drizzle-kit': '^0.30.0' },
    })
    initCommand(dir)

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.scripts['db:generate']).toBe('echo custom-generate')
    expect(pkg.scripts.mcp).toBe('echo custom-mcp')
    expect(pkg.scripts.doctor).toBe('echo custom-doctor')
    expect(pkg.scripts['db:migrate']).toBe('cloudconfig db migrate')
    expect(pkg.scripts['db:status']).toBe('cloudconfig db status')
    expect(pkg.dependencies['better-sqlite3']).toBe('^11.0.0')
    expect(pkg.devDependencies['better-sqlite3']).toBeUndefined()
    expect(pkg.devDependencies['drizzle-kit']).toBe('^0.30.0')
  })

  it('is idempotent for package.json merges on Nuxt/Next', () => {
    writePkg({
      name: 'my-nuxt',
      scripts: { dev: 'nuxt dev' },
      dependencies: { nuxt: '^4' },
    })
    initCommand(dir)
    const first = readFileSync(join(dir, 'package.json'), 'utf8')
    initCommand(dir)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(first)
  })

  it('merges CloudConfig scripts and local sqlite deps into an existing standalone package.json', () => {
    writePkg({
      name: 'existing-api',
      scripts: { lint: 'eslint .' },
      dependencies: { express: '^4' },
    })
    initCommand(dir)

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.scripts).toMatchObject({
      lint: 'eslint .',
      dev: 'cloudconfig dev',
      start: 'node --experimental-strip-types server.ts',
      'db:generate': 'cloudconfig db generate',
      'db:migrate': 'cloudconfig db migrate',
      'db:status': 'cloudconfig db status',
      doctor: 'cloudconfig doctor',
      mcp: 'cloudconfig mcp',
    })
    expect(pkg.dependencies.express).toBe('^4')
    expect(pkg.devDependencies['better-sqlite3']).toBe('^12.0.0')
    expect(pkg.devDependencies['drizzle-kit']).toBe('^0.31.0')
  })

  it('does not overwrite existing standalone scripts or dependency versions', () => {
    writePkg({
      name: 'existing-api',
      scripts: {
        dev: 'node server.js',
        'db:generate': 'echo custom-generate',
      },
      dependencies: { 'better-sqlite3': '^11.0.0' },
      devDependencies: { 'drizzle-kit': '^0.30.0' },
    })
    initCommand(dir)

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.scripts.dev).toBe('node server.js')
    expect(pkg.scripts['db:generate']).toBe('echo custom-generate')
    expect(pkg.scripts['db:migrate']).toBe('cloudconfig db migrate')
    expect(pkg.scripts['db:status']).toBe('cloudconfig db status')
    expect(pkg.scripts.doctor).toBe('cloudconfig doctor')
    expect(pkg.scripts.mcp).toBe('cloudconfig mcp')
    expect(pkg.scripts.start).toBe('node --experimental-strip-types server.ts')
    expect(pkg.dependencies['better-sqlite3']).toBe('^11.0.0')
    expect(pkg.devDependencies['better-sqlite3']).toBeUndefined()
    expect(pkg.devDependencies['drizzle-kit']).toBe('^0.30.0')
  })

  it('is idempotent for package.json merges on standalone', () => {
    writePkg({ name: 'existing-api', scripts: { lint: 'eslint .' } })
    initCommand(dir)
    const first = readFileSync(join(dir, 'package.json'), 'utf8')
    initCommand(dir)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(first)
  })
})
