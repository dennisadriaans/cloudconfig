/** Reproducible Nuxt package/deployment defaults, independent of agent prose. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { modify, applyEdits, parse, type ParseError } from 'jsonc-parser'
import { readWranglerFile } from './cloudflare/wrangler-config.js'
import { ensureGitignored, generateSecret, upsertEnvValues } from './auth-env.js'
import { ENV_FILE, readLocalSecrets } from './cloudflare/secrets.js'
import { NUXT_DASHBOARD_TEMPLATE } from './nuxt-dashboard-template.js'
import { DASHBOARD_STARTER_CONFIG } from './dashboard-starter.js'
import { findConfigPath } from './config-load.js'
import { withConfigFilename } from './scaffold.js'
import { readCloudconfigPackage } from './package-info.js'

export const NUXT_DASHBOARD_DEPENDENCIES = {
  '@nuxt/ui': '^4.11.1',
  tailwindcss: '^4.0.0',
}

export function cloudconfigDependencies(projectDir: string): Record<string, string> {
  const { directory, version } = readCloudconfigPackage()
  const nuxt = join(dirname(directory), 'nuxt')
  if (existsSync(join(nuxt, 'package.json'))) {
    const sibling = JSON.parse(readFileSync(join(nuxt, 'package.json'), 'utf8')) as {
      name?: string
    }
    if (sibling.name === '@cloudconfig/nuxt') {
      // Source checkouts use built local packages; installed CLIs pin both releases to their own version.
      const link = (target: string) =>
        `link:${relative(projectDir, target).split('\\').join('/') || '.'}`
      return { '@cloudconfig/core': link(directory), '@cloudconfig/nuxt': link(nuxt) }
    }
  }
  if (version === '0.0.0') {
    throw new Error(
      'Build CloudConfig from its source checkout before scaffolding; no released package version is available.',
    )
  }
  return { '@cloudconfig/core': version, '@cloudconfig/nuxt': version }
}

export function prepareNuxtPackage(projectDir: string, dashboard = false): boolean {
  mkdirSync(projectDir, { recursive: true })
  const pkgPath = join(projectDir, 'package.json')
  if (existsSync(pkgPath)) return false
  writeFileSync(
    pkgPath,
    JSON.stringify(
      {
        name:
          basename(projectDir)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-') || 'cloudconfig-app',
        private: true,
        type: 'module',
        scripts: { dev: 'nuxt dev', build: 'nuxt build', typecheck: 'nuxt typecheck' },
        dependencies: {
          // Resolve the current stable release when the new app is installed.
          nuxt: 'latest',
          vue: '^3.5.43',
          'vue-router': '^5.4.0',
          ...(dashboard ? NUXT_DASHBOARD_DEPENDENCIES : {}),
        },
      },
      null,
      2,
    ) + '\n',
  )
  return true
}

export function configureCloudflare(projectDir: string): void {
  const existing = readWranglerFile(projectDir)
  if (existing?.format === 'toml') {
    throw new Error(
      'Nuxt Cloudflare setup needs wrangler.jsonc. Convert wrangler.toml first; it was not overwritten.',
    )
  }
  let text = existing?.text ?? '{}\n'
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Wrangler JSON configuration.')
  }
  const config = value as Record<string, unknown>
  const assets = config['assets'] as Record<string, unknown> | undefined
  const flags = config['compatibility_flags']
  if (
    (config['main'] && config['main'] !== '.output/server/index.mjs') ||
    config['pages_build_output_dir'] ||
    (assets && (typeof assets !== 'object' || Array.isArray(assets))) ||
    (assets?.['directory'] && assets['directory'] !== '.output/public') ||
    (assets?.['binding'] && assets['binding'] !== 'ASSETS') ||
    (flags !== undefined &&
      (!Array.isArray(flags) || !flags.every((flag) => typeof flag === 'string')))
  ) {
    throw new Error(
      'Existing Wrangler configuration conflicts with the Nuxt Worker entry/assets. Reconcile it before retrying; it was not overwritten.',
    )
  }
  const changes: [string[], unknown][] = [
    [
      ['name'],
      config['name'] ??
        basename(resolve(projectDir))
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-'),
    ],
    [['main'], '.output/server/index.mjs'],
    [['compatibility_date'], config['compatibility_date'] ?? new Date().toISOString().slice(0, 10)],
    [
      ['compatibility_flags'],
      [...new Set([...(Array.isArray(flags) ? flags : []), 'nodejs_compat'])],
    ],
    [['assets', 'directory'], '.output/public'],
    [['assets', 'binding'], 'ASSETS'],
    [['workers_dev'], config['workers_dev'] ?? true],
    [['observability', 'enabled'], true],
    [['vars', 'NODE_ENV'], 'production'],
  ]
  for (const [path, value] of changes) {
    text = applyEdits(
      text,
      modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    )
  }
  writeFileSync(
    existing?.path ?? join(projectDir, 'wrangler.jsonc'),
    text.endsWith('\n') ? text : text + '\n',
  )
}

export function prepareNuxtSecret(projectDir: string): void {
  // Called only for the known generated config, never guessing an existing
  // project's auth settings. Re-runs preserve the signing key and sessions.
  if (process.env['BETTER_AUTH_SECRET'] || readLocalSecrets(projectDir)['BETTER_AUTH_SECRET']) {
    return
  }
  upsertEnvValues(projectDir, ENV_FILE, { BETTER_AUTH_SECRET: generateSecret() })
}

export function prepareNuxtProjectFiles(projectDir: string): void {
  const tsconfig = join(projectDir, 'tsconfig.json')
  if (!existsSync(tsconfig)) {
    writeFileSync(
      tsconfig,
      JSON.stringify(
        {
          files: [],
          references: ['app', 'server', 'shared', 'node'].map((name) => ({
            path: `./.nuxt/tsconfig.${name}.json`,
          })),
        },
        null,
        2,
      ) + '\n',
    )
  }
  const ignore = join(projectDir, '.gitignore')
  const original = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
  const entries = ['node_modules', '.nuxt', '.output', '.cloudconfig', '.wrangler', '.env.*']
  const missing = entries.filter((entry) => !original.split(/\r?\n/).includes(entry))
  if (missing.length) {
    writeFileSync(
      ignore,
      original + (original.endsWith('\n') || !original ? '' : '\n') + missing.join('\n') + '\n',
    )
  }
  ensureGitignored(projectDir, ENV_FILE)
}

/**
 * Validate the dashboard template as one operation. Existing application files
 * are never replaced and a customized CloudConfig config is never paired with a UI
 * that assumes the starter note model.
 */
export function preflightNuxtDashboardTemplate(projectDir: string): void {
  const configPath = findConfigPath(projectDir)
  const configFilename = configPath ? basename(configPath) : 'cloud.config.ts'
  const conflicts = Object.entries(NUXT_DASHBOARD_TEMPLATE)
    .filter(([path, expected]) => {
      const target = join(projectDir, path)
      return (
        existsSync(target) &&
        readFileSync(target, 'utf8') !== withConfigFilename(expected, configFilename)
      )
    })
    .map(([path]) => path)
  if (existsSync(join(projectDir, 'app.vue'))) conflicts.push('app.vue')
  if (configPath && readFileSync(configPath, 'utf8') !== DASHBOARD_STARTER_CONFIG) {
    conflicts.push(basename(configPath))
  }
  if (conflicts.length > 0) {
    throw new Error(
      `The dashboard template is additive and will not overwrite an existing app. Conflicting files:\n${conflicts.map((path) => `  - ${path}`).join('\n')}\nRun cloudconfig init without --template to integrate CloudConfig while preserving the UI.`,
    )
  }

  const pkgPath = join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) return
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  if (!pkg.dependencies?.['@nuxt/ui'] && !pkg.devDependencies?.['@nuxt/ui']) {
    throw new Error(
      'The dashboard template requires an existing @nuxt/ui installation. Add and configure Nuxt UI, then rerun init --template dashboard; CloudConfig did not modify the app.',
    )
  }
}

export function writeNuxtDashboardTemplate(
  projectDir: string,
  configFilename = 'cloud.config.ts',
): string[] {
  const written: string[] = []
  for (const [relativePath, content] of Object.entries(NUXT_DASHBOARD_TEMPLATE)) {
    const path = join(projectDir, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, withConfigFilename(content, configFilename))
    written.push(relativePath)
  }
  return written
}
