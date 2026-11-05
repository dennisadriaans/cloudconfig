/**
 * Project health checks for `cloudconfig doctor`.
 *
 * Kept out of `commands/doctor.ts` / `cli/index.ts` so tests can run the
 * report without shelling out or importing the CLI entrypoint side effects.
 *
 * Reuses the same install / migrate preflight helpers as the individual
 * commands so a green doctor matches what `generate` / `migrate` / `dev` expect.
 * For Next/Nuxt, also warns when the framework config does not mark
 * `better-sqlite3` external (the same hint `cloudconfig init` prints for opaque configs).
 * For local SQLite paths, also warns when on-disk SQL is ahead of the
 * `_cloudconfig_migrations` ledger (same signal as `cloudconfig db status`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { loadConfig } from './config-load.js'
import { detectFramework, type Framework } from './detect.js'
import { isDrizzleKitInstalled, missingDrizzleKitMessage } from './drizzle-kit.js'
import { inspectFrameworkExternals } from './framework-externals.js'
import { inspectNuxtModule, NUXT_MODULE_NAME } from './nuxt-module.js'
import {
  NO_MIGRATIONS_HINT,
  listMigrationSqlFiles,
  listPendingLocalMigrations,
} from './migrate-local.js'
import { detectPackageManager, installDepCommand, installDevDepCommand } from './package-manager.js'
import { hasBetterAuth, hasPasskey } from './better-auth.js'
import { resolveConnect } from '../shared/connect-resolve.js'
import { readLocalSecrets } from './cloudflare/secrets.js'
import { providerLabel } from '../shared/auth-providers.js'
import { resolveAuth } from '../shared/auth-resolve.js'
import { mountFileFor } from './scaffold.js'
import { hasWranglerConfig, isWranglerInstalled, missingWranglerMessage } from './wrangler.js'
import {
  isValidCustomDomain,
  readCustomDomains,
  readWranglerFile,
} from './cloudflare/wrangler-config.js'
import { missingBetterSqlite3Message } from '../shared/better-sqlite3.js'
import { LOCAL_DB_PATH } from '../shared/local-db.js'
import { formatCliError } from './format-error.js'
import { resolveProjectConfig } from '../shared/project-config.js'
import { workloadChecks } from './doctor-workloads.js'

export type DoctorStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  label: string
  status: DoctorStatus
  detail: string
}

export interface DoctorReport {
  framework: Framework
  checks: DoctorCheck[]
  /** False when any check failed (warnings alone still pass). */
  ok: boolean
}

export interface DoctorOptions {
  isDrizzleKitInstalled?: (projectDir: string) => boolean
  isWranglerInstalled?: (projectDir: string) => boolean
  hasBetterSqlite3?: (projectDir: string) => boolean
  loadConfig?: typeof loadConfig
}

/** Walk up from `projectDir` looking for `node_modules/better-sqlite3/package.json`. */
export function hasLocalBetterSqlite3(projectDir: string, maxDepth = 6): boolean {
  let cur = projectDir
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(cur, 'node_modules', 'better-sqlite3', 'package.json'))) return true
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
}

function check(id: string, label: string, status: DoctorStatus, detail: string): DoctorCheck {
  return { id, label, status, detail }
}

/**
 * Run readiness checks for a CloudConfig project directory.
 * Does not print — callers format the report for the terminal.
 */
export async function runDoctor(
  projectDir: string,
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const framework = detectFramework(projectDir)
  const pm = detectPackageManager(projectDir)
  const checks: DoctorCheck[] = []

  const drizzleProbe = opts.isDrizzleKitInstalled ?? isDrizzleKitInstalled
  const wranglerProbe = opts.isWranglerInstalled ?? isWranglerInstalled
  const sqliteProbe = opts.hasBetterSqlite3 ?? hasLocalBetterSqlite3
  const load = opts.loadConfig ?? loadConfig

  checks.push(check('framework', 'Framework', 'ok', framework))

  let migrationsDirRel = 'migrations'
  let localDbPath = LOCAL_DB_PATH
  let loaded: Awaited<ReturnType<typeof loadConfig>> | undefined
  try {
    loaded = await load(projectDir)
    const { path, config } = loaded
    const resolved = resolveProjectConfig(config)
    migrationsDirRel = resolved.migrationsDir
    localDbPath = resolved.localDbPath
    checks.push(check('config', 'Config', 'ok', path))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    checks.push(check('config', 'Config', 'fail', message))
  }

  const nuxtModule = framework === 'nuxt' ? inspectNuxtModule(projectDir) : undefined
  if (nuxtModule) {
    const module = nuxtModule
    if (module.status === 'missing') {
      checks.push(check('mount', 'Mount', 'fail', 'No nuxt.config.* found. Run: cloudconfig init'))
    } else if (module.status === 'manual') {
      checks.push(check('mount', 'Mount', 'fail', `${basename(module.path)}: ${module.hint}`))
    } else {
      checks.push(check('mount', 'Mount', 'ok', `${NUXT_MODULE_NAME} registered`))
    }
    // A project scaffolded before the module still has the old catch-all; two
    // handlers on the same route is a coin flip, so say so.
    const legacyMount = join(projectDir, 'server', 'api', '[...].ts')
    if (existsSync(legacyMount)) {
      checks.push(
        check(
          'mount',
          'Legacy mount',
          'warn',
          `server/api/[...].ts predates ${NUXT_MODULE_NAME} — delete it so the module owns the route`,
        ),
      )
    }
  }

  const mount = framework === 'nuxt' ? undefined : mountFileFor(framework)
  if (mount) {
    const mountPath = join(projectDir, mount.path)
    if (!existsSync(mountPath)) {
      checks.push(check('mount', 'Mount', 'fail', `Missing ${mount.path}. Run: cloudconfig init`))
    } else {
      const src = readFileSync(mountPath, 'utf8')
      if (!src.includes('createBackend')) {
        checks.push(
          check('mount', 'Mount', 'warn', `${mount.path} exists but does not call createBackend`),
        )
      } else if (!/\bsqliteFile\s*\(/.test(src) && !/\bd1\s*\(/.test(src)) {
        checks.push(
          check(
            'mount',
            'Mount',
            'warn',
            `${mount.path}: no sqliteFile(...) or d1(...) driver — first request may fail`,
          ),
        )
      } else {
        checks.push(check('mount', 'Mount', 'ok', mount.path))
      }
    }
  } else if (framework === 'standalone') {
    checks.push(check('mount', 'Mount', 'ok', 'standalone (cloudconfig dev)'))
  }

  if (drizzleProbe(projectDir)) {
    checks.push(check('drizzle-kit', 'drizzle-kit', 'ok', 'found on local node_modules/.bin'))
  } else {
    checks.push(
      check(
        'drizzle-kit',
        'drizzle-kit',
        'fail',
        missingDrizzleKitMessage(installDevDepCommand(pm, 'drizzle-kit')),
      ),
    )
  }

  if (sqliteProbe(projectDir)) {
    checks.push(check('better-sqlite3', 'better-sqlite3', 'ok', 'found in node_modules'))
  } else {
    checks.push(
      check(
        'better-sqlite3',
        'better-sqlite3',
        'fail',
        missingBetterSqlite3Message(installDevDepCommand(pm, 'better-sqlite3')),
      ),
    )
  }

  // A registered module sets the nitro externals itself, so the Nuxt config does
  // not have to name better-sqlite3 — only fall back to the file check without it.
  const externals =
    nuxtModule?.status === 'skipped'
      ? ({
          status: 'ok',
          path: basename(nuxtModule.path),
          detail: `${NUXT_MODULE_NAME} marks better-sqlite3 external`,
        } as const)
      : inspectFrameworkExternals(projectDir, framework)
  if (externals.status === 'ok') {
    checks.push(check('externals', 'Framework externals', 'ok', externals.detail))
  } else if (externals.status === 'warn') {
    const where = externals.path ? `${externals.path}: ` : ''
    checks.push(check('externals', 'Framework externals', 'warn', `${where}${externals.hint}`))
  }

  // Auth checks only appear once a project has an auth block — a project
  // without sign-in should not be told anything about sign-in.
  const auth = loaded ? resolveAuth(loaded.config) : undefined
  if (auth) {
    if (hasBetterAuth(projectDir)) {
      checks.push(check('auth', 'Auth', 'ok', `mounted at ${auth.basePath}`))
    } else {
      checks.push(
        check(
          'auth',
          'Auth',
          'fail',
          `better-auth is not installed. Run: ${installDepCommand(pm, 'better-auth')}`,
        ),
      )
    }

    const local = readLocalSecrets(projectDir)
    const present = (key: string): boolean => Boolean(local[key] ?? process.env[key])
    if (auth.twoFactor) {
      const email = auth.twoFactor.email
      const missing = [email.apiKeyEnv, email.serviceUrlEnv].filter((key) => !present(key))
      checks.push(
        check(
          'auth-email',
          'Email OTP',
          missing.length ? 'warn' : 'ok',
          missing.length
            ? `${missing.join(', ')} missing — development prints codes locally; production requires an email service. Run: cloudconfig auth email`
            : 'DashboardStack / Cloudflare email service configured',
        ),
      )
      if (auth.twoFactor.passkey !== false && !hasPasskey(projectDir)) {
        checks.push(
          check(
            'auth-passkey',
            'Passkey',
            'fail',
            `Install the passkey plugin: ${installDepCommand(pm, '@better-auth/passkey')}`,
          ),
        )
      }
    }
    if (!present(auth.secretEnv)) {
      checks.push(
        check(
          'auth-secret',
          'Auth secret',
          'warn',
          `${auth.secretEnv} is not set — development falls back to a shared throwaway secret, production refuses to start. Run: cloudconfig auth secret`,
        ),
      )
    }

    const incomplete = auth.providers.filter(
      (authProvider) =>
        !present(authProvider.clientIdEnv) || !present(authProvider.clientSecretEnv),
    )
    if (incomplete.length > 0) {
      checks.push(
        check(
          'auth-providers',
          'Auth providers',
          'warn',
          `no credentials for ${incomplete.map((authProvider) => providerLabel(authProvider.id)).join(', ')} — those providers stay disabled. Run: cloudconfig auth add ${incomplete[0]?.id ?? ''}`,
        ),
      )
    }
  }

  // Connect: the sealing key, and which providers still lack credentials.
  const connect = loaded ? resolveConnect(loaded.config) : undefined
  if (connect) {
    const local = readLocalSecrets(projectDir)
    const present = (key: string): boolean => Boolean(local[key] ?? process.env[key])
    checks.push(
      present(connect.keyEnv)
        ? check('connect-key', 'Connect key', 'ok', `${connect.keyEnv} set`)
        : check(
            'connect-key',
            'Connect key',
            'warn',
            `${connect.keyEnv} is not set — development uses a throwaway key, production refuses to seal tokens. Run: cloudconfig connect key`,
          ),
    )
    const unconfigured = connect.providers.filter(
      (provider) =>
        !present(provider.clientIdEnv) ||
        !present(provider.clientSecretEnv) ||
        provider.extraEnv.some((extra) => !extra.optional && !present(extra.env)),
    )
    if (unconfigured.length > 0) {
      checks.push(
        check(
          'connect-providers',
          'Connect providers',
          'warn',
          `not set up yet: ${unconfigured.map((provider) => provider.label).join(', ')} — users see them as unavailable. Run: cloudconfig connect add ${unconfigured[0]?.id ?? ''}`,
        ),
      )
    }
  }

  const configOk = checks.some((c) => c.id === 'config' && c.status === 'ok')
  if (loaded) checks.push(...workloadChecks({ config: loaded.config, projectDir, framework }))
  if (configOk) {
    const migrationsAbs = join(projectDir, migrationsDirRel)
    const files = listMigrationSqlFiles(migrationsAbs)
    if (files.length === 0) {
      checks.push(check('migrations', 'Migrations', 'fail', NO_MIGRATIONS_HINT))
    } else {
      const canInspectLocalLedger =
        sqliteProbe(projectDir) &&
        (framework === 'standalone' || framework === 'nuxt' || !hasWranglerConfig(projectDir))

      if (canInspectLocalLedger) {
        try {
          const pending = listPendingLocalMigrations(join(projectDir, localDbPath), files, {
            installCommand: installDevDepCommand(pm, 'better-sqlite3'),
          })
          if (pending.length > 0) {
            checks.push(
              check(
                'migrations',
                'Migrations',
                'warn',
                `${files.length} SQL file(s) in ${migrationsDirRel}/; pending locally: ${pending.join(', ')}. Run: cloudconfig db migrate`,
              ),
            )
          } else {
            checks.push(
              check(
                'migrations',
                'Migrations',
                'ok',
                `${files.length} SQL file(s) applied in ${migrationsDirRel}/`,
              ),
            )
          }
        } catch (err) {
          const message = formatCliError(err, projectDir)
          checks.push(check('migrations', 'Migrations', 'warn', message))
        }
      } else {
        checks.push(
          check(
            'migrations',
            'Migrations',
            'ok',
            `${files.length} SQL file(s) in ${migrationsDirRel}/`,
          ),
        )
      }
    }
  }

  if (hasWranglerConfig(projectDir)) {
    if (wranglerProbe(projectDir)) {
      checks.push(check('wrangler', 'wrangler', 'ok', 'found on local node_modules/.bin'))
    } else {
      checks.push(
        check(
          'wrangler',
          'wrangler',
          'fail',
          missingWranglerMessage(installDevDepCommand(pm, 'wrangler')),
        ),
      )
    }
  }

  // `deploy.domain` is only read at deploy time, so a typo would otherwise sit
  // in the config until the deploy that needs it. Report it here instead.
  const domain = loaded?.config.deploy?.domain
  if (domain !== undefined) {
    if (!isValidCustomDomain(domain)) {
      checks.push(
        check(
          'domain',
          'Custom domain',
          'fail',
          `deploy.domain "${domain}" is not a hostname (expected e.g. api.example.com).`,
        ),
      )
    } else {
      const routed = readWranglerFile(projectDir)
      const already = routed ? readCustomDomains(routed.text).includes(domain.trim()) : false
      checks.push(
        check(
          'domain',
          'Custom domain',
          'ok',
          already ? `${domain} (routed)` : `${domain} (added by cloudconfig deploy)`,
        ),
      )
    }
  }

  return {
    framework,
    checks,
    ok: checks.every((c) => c.status !== 'fail'),
  }
}
