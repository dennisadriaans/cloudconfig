/**
 * `cloudconfig dev` — the standalone development server. Boot-applies pending migrations
 * to the local sqlite db, serves the backend over @hono/node-server, and watches
 * the config file, printing a hint (not auto-generating) when the schema changes.
 */
import { existsSync, readFileSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import pc from 'picocolors'
import { loadConfig } from '../config-load.js'
import { listenDevServer, type ServeLike } from '../dev-port.js'
import { applyLocalMigrations, NO_MIGRATIONS_HINT } from '../migrate-local.js'
import { detectPackageManager, installDevDepCommand } from '../package-manager.js'
import { resolveProjectConfig } from '../../shared/project-config.js'
import { DEV_IDP_SEGMENT, resolveAuth } from '../../shared/auth-resolve.js'
import { readLocalSecrets } from '../cloudflare/secrets.js'
import { createStudioDevtools, STUDIO_PATH } from '../../devtools/studio.js'
import { renderDocsHtml } from '../../server/routes/docs.js'

export async function devCommand(
  projectDir: string,
  port: number,
  options: { studio?: boolean } = {},
): Promise<void> {
  // The development identity provider only mounts when the environment says
  // "development" out loud — an unset NODE_ENV counts as production.
  process.env['NODE_ENV'] ??= 'development'
  for (const [key, value] of Object.entries(readLocalSecrets(projectDir))) {
    process.env[key] ??= value
  }

  const { path, config } = await loadConfig(projectDir)
  const resolved = resolveProjectConfig(config)
  const localDb = resolve(projectDir, resolved.localDbPath)
  const migrationsDir = join(projectDir, resolved.migrationsDir)
  const installCommand = installDevDepCommand(detectPackageManager(projectDir), 'better-sqlite3')

  const migrate = applyLocalMigrations(localDb, migrationsDir, {
    installCommand,
  })
  if (migrate.onDisk === 0) {
    console.log(pc.yellow(`${NO_MIGRATIONS_HINT} (then restart)`))
  } else if (migrate.applied.length > 0) {
    console.log(pc.green(`Applied ${migrate.applied.length} pending migration(s).`))
  }

  const { createBackend } = await import('../../server/index.js')
  const { sqliteFile } = await import('../../drivers/better-sqlite3.js')
  const { serve } = await import('@hono/node-server')

  const backend = createBackend(config, { db: sqliteFile(localDb) })
  const app = new Hono()
  const studio =
    options.studio !== false && process.env['NODE_ENV'] === 'development'
      ? createStudioDevtools({ projectDir, databasePath: localDb })
      : undefined
  if (studio) {
    app.all(STUDIO_PATH, (c) => studio.handle(c.req.raw))
    app.get(`${STUDIO_PATH}/client.js`, (c) => studio.handle(c.req.raw))
  }
  const basePath = resolved.basePath === '/' ? '' : resolved.basePath
  const homepagePath = join(projectDir, 'dashboard', 'index.html')
  const auth = resolveAuth(config)
  function withStudio(html: string): string {
    if (!studio) return html
    const script = `<script type="module" src="${STUDIO_PATH}/client.js"></script>`
    return /<\/body\s*>/i.test(html)
      ? html.replace(/<\/body\s*>/i, `${script}</body>`)
      : html + script
  }
  if (existsSync(homepagePath)) {
    const homepageHtml = withStudio(readFileSync(homepagePath, 'utf8'))
    app.get('/', (c) => c.html(homepageHtml))
    const clientJs = readFileSync(new URL(import.meta.resolve('@cloudconfig/core/browser')), 'utf8')
    app.get('/_cloudconfig/client.js', (c) =>
      c.body(clientJs, 200, { 'content-type': 'text/javascript' }),
    )
  }
  if (studio && config.server?.docs !== false) {
    const docsHtml = renderDocsHtml(resolved.basePath, { studio: true })
    app.get(`${basePath}/_docs`, (c) => c.html(docsHtml))
    if (!existsSync(homepagePath)) app.get('/', (c) => c.html(docsHtml))
  }
  app.all('*', (c) => backend.fetch(c.req.raw))

  let server: Awaited<ReturnType<typeof listenDevServer>>
  try {
    server = await listenDevServer(serve as ServeLike, app.fetch, port)
  } catch (error) {
    await studio?.dispose()
    throw error
  }
  console.log(pc.bold(`\nCloudConfig dev server on ${pc.cyan(`http://localhost:${port}`)}`))
  console.log(pc.dim(`  API   http://localhost:${port}${basePath}`))
  if (config.server?.docs !== false) {
    console.log(pc.dim(`  Docs  http://localhost:${port}${basePath}/_docs`))
  }
  if (existsSync(homepagePath) || config.server?.docs !== false) {
    console.log(pc.dim(`  App   http://localhost:${port}/`))
  }
  if (auth) {
    console.log(pc.dim(`  Auth  http://localhost:${port}${auth.basePath}`))
    if (auth.devIdp.enabled) {
      console.log(
        pc.dim(
          `        development IdP at ${auth.basePath}${DEV_IDP_SEGMENT}/authorize — sign in with provider id "dev", no credentials needed`,
        ),
      )
    }
  }
  console.log()

  const watcher = watch(path, () => {
    console.log(pc.yellow('\nSchema changed → run: cloudconfig db generate (then restart)'))
  })

  async function shutdown() {
    watcher.close()
    await studio?.dispose()
    server.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
