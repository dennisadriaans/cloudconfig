import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'jsonc-parser'
import { initCommand } from '../src/cli/commands/init.js'
import { runScriptCommand } from '../src/cli/package-manager.js'
import { DASHBOARD_STARTER_CONFIG } from '../src/cli/dashboard-starter.js'

let parent: string
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'cloudconfig-nuxt-setup-'))
  vi.stubEnv('BETTER_AUTH_SECRET', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(parent, { recursive: true, force: true })
})
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8')

describe('Nuxt Cloudflare initialization', () => {
  it('uses the legacy config filename in dashboard guidance and remains idempotent', () => {
    const dir = join(parent, 'legacy-notes')
    mkdirSync(dir)
    writeFileSync(join(dir, 'cloudconfig.config.ts'), DASHBOARD_STARTER_CONFIG)
    initCommand(dir, { target: 'nuxt', template: 'dashboard' })
    expect(existsSync(join(dir, 'cloud.config.ts'))).toBe(false)
    expect(read(dir, 'app/pages/dashboard/index.vue')).toContain(
      'auth.admin.userIds in cloudconfig.config.ts',
    )
    expect(() => initCommand(dir, { target: 'nuxt', template: 'dashboard' })).not.toThrow()
  })

  it('creates a complete app from a directory that does not yet exist', () => {
    const dir = join(parent, 'notes')
    initCommand(dir, { target: 'nuxt', cloudflare: true, template: 'dashboard' })
    const pkg = JSON.parse(read(dir, 'package.json'))
    expect(pkg.dependencies.nuxt).toBe('latest')
    expect(pkg.dependencies['@nuxt/ui']).toBe('^4.11.1')
    expect(pkg.dependencies.tailwindcss).toBe('^4.0.0')
    expect(pkg.dependencies.cloudconfig).toBeUndefined()
    for (const name of ['@cloudconfig/core', '@cloudconfig/nuxt']) {
      const spec = pkg.dependencies[name] as string
      expect(spec.startsWith('link:')).toBe(true)
      expect(JSON.parse(read(resolve(dir, spec.slice(5)), 'package.json')).name).toBe(name)
    }
    expect(pkg.scripts).toMatchObject({
      build: 'nuxt build',
      typecheck: 'nuxt typecheck',
      deploy: 'cloudconfig deploy',
    })
    expect(read(dir, '.env')).toMatch(/^BETTER_AUTH_SECRET=[A-Za-z0-9_-]{43}\n$/)
    expect(read(dir, '.env.example')).toContain('BETTER_AUTH_SECRET=\n')
    expect(read(dir, '.gitignore').split('\n')).toContain('.env')
    expect(read(dir, '.gitignore').split('\n')).toContain('!.env.example')
    // Both pages render the one component that owns the GitHub sign-in call.
    expect(read(dir, 'app/components/GithubAuthPanel.vue')).toContain(
      "auth.signIn.social({ provider: 'github', callbackURL: '/dashboard' })",
    )
    expect(read(dir, 'app/pages/sign-up.vue')).toContain('<GithubAuthPanel')
    expect(read(dir, 'app/pages/sign-in.vue')).toContain('<GithubAuthPanel')
    expect(read(dir, 'app/layouts/dashboard.vue')).toContain('UDashboardSidebar')
    expect(read(dir, 'app/pages/dashboard/index.vue')).toContain('<ServerTable')
    // Verify the shell's theme is wired, without pinning obsolete blue-theme values.
    expect(read(dir, 'app/app.vue')).toContain("import '~/assets/css/main.css'")
    expect(read(dir, 'app/app.config.ts')).toContain('defineAppConfig')
    expect(read(dir, 'app/assets/css/main.css')).toContain('--ui-bg:')
    expect(read(dir, 'cloud.config.ts')).toContain('providers: { github: true }')
    expect(existsSync(join(dir, 'app/composables/useDashboardTheme.ts'))).toBe(false)
    expect(existsSync(join(dir, 'server/cloudconfig/user.ts'))).toBe(false)
    const wrangler = parse(read(dir, 'wrangler.jsonc'))
    expect(wrangler).toMatchObject({
      main: '.output/server/index.mjs',
      assets: { directory: '.output/public', binding: 'ASSETS' },
      vars: { NODE_ENV: 'production' },
    })
    expect(wrangler.d1_databases).toBeUndefined()
    expect(read(dir, 'nuxt.config.ts')).toContain('cloudflare: true')
    expect(existsSync(join(dir, '.agents/skills/cloudconfig-nuxt-setup/SKILL.md'))).toBe(true)
  })

  it('keeps source files, signing key, and provisioned D1 identity across re-runs', () => {
    const dir = join(parent, 'notes')
    initCommand(dir, { target: 'nuxt', cloudflare: true, template: 'dashboard' })
    const key = read(dir, '.env')
    const envExample = '# Existing local settings\nBETTER_AUTH_SECRET=\nMY_SETTING=default\n'
    writeFileSync(join(dir, '.env.example'), envExample)
    writeFileSync(join(dir, 'app/app.vue'), '<template>My existing UI</template>')
    const config = read(dir, 'cloud.config.ts') + '\n// Existing application customization\n'
    writeFileSync(join(dir, 'cloud.config.ts'), config)
    const wrangler = parse(read(dir, 'wrangler.jsonc'))
    wrangler.d1_databases = [
      {
        binding: 'DB',
        database_id: 'existing-id',
        database_name: 'existing-db',
        migrations_dir: 'migrations',
      },
    ]
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify(wrangler))
    initCommand(dir, { target: 'nuxt', cloudflare: true })
    expect(read(dir, '.env')).toBe(key)
    expect(read(dir, '.env.example')).toBe(envExample)
    expect(read(dir, 'app/app.vue')).toBe('<template>My existing UI</template>')
    expect(read(dir, 'cloud.config.ts')).toBe(config)
    expect(parse(read(dir, 'wrangler.jsonc')).d1_databases).toEqual(wrangler.d1_databases)
  })

  it('keeps plain init UI-free for existing and nearly finished apps', () => {
    const dir = join(parent, 'backend-only')
    initCommand(dir, { target: 'nuxt', cloudflare: true })
    expect(existsSync(join(dir, 'app/app.vue'))).toBe(false)
    expect(existsSync(join(dir, 'app/pages/sign-in.vue'))).toBe(false)
    expect(read(dir, 'cloud.config.ts')).toContain('post: model')
  })

  it('refuses the dashboard template before overwriting any existing UI', () => {
    writeFileSync(
      join(parent, 'package.json'),
      JSON.stringify({
        name: 'existing-app',
        dependencies: { nuxt: '^4', '@nuxt/ui': '^4' },
      }),
    )
    mkdirSync(join(parent, 'app'))
    writeFileSync(join(parent, 'app/app.vue'), '<template>Existing</template>')

    expect(() => initCommand(parent, { target: 'nuxt', template: 'dashboard' })).toThrow(
      'will not overwrite',
    )
    expect(read(parent, 'app/app.vue')).toBe('<template>Existing</template>')
    expect(existsSync(join(parent, 'cloud.config.ts'))).toBe(false)
  })

  it('adds the backend to an existing Nuxt app without replacing its UI, module options, or scripts', () => {
    writeFileSync(
      join(parent, 'package.json'),
      JSON.stringify({
        name: 'existing-app',
        dependencies: { nuxt: '^4', '@cloudconfig/core': 'workspace:*' },
        scripts: { build: 'nuxt build --logLevel=verbose' },
      }),
    )
    writeFileSync(
      join(parent, 'nuxt.config.ts'),
      "export default defineNuxtConfig({ modules: ['other-module'], cloudconfig: { client: false } })\n",
    )
    mkdirSync(join(parent, 'app'))
    writeFileSync(join(parent, 'app/app.vue'), '<template>Existing</template>')
    initCommand(parent, { target: 'nuxt', cloudflare: true })
    expect(read(parent, 'nuxt.config.ts')).toContain('client: false')
    expect(read(parent, 'nuxt.config.ts')).toContain('other-module')
    expect(read(parent, 'nuxt.config.ts')).toContain('cloudflare: true')
    expect(read(parent, 'app/app.vue')).toBe('<template>Existing</template>')
    const pkg = JSON.parse(read(parent, 'package.json'))
    expect(pkg.dependencies.nuxt).toBe('^4')
    expect(pkg.dependencies['@cloudconfig/core']).toBe('workspace:*')
    expect(pkg.scripts.build).toBe('nuxt build --logLevel=verbose')
  })

  it('refuses to repoint an existing Worker or erase its config', () => {
    const original = '{ "name": "important", "main": "src/worker.ts" }\n'
    writeFileSync(join(parent, 'wrangler.jsonc'), original)
    expect(() => initCommand(parent, { target: 'nuxt', cloudflare: true })).toThrow('conflicts')
    expect(read(parent, 'wrangler.jsonc')).toBe(original)
  })

  it('does not confuse the deploy script with pnpm deployment', () => {
    expect(runScriptCommand('pnpm', 'deploy')).toBe('pnpm run deploy')
  })
})
