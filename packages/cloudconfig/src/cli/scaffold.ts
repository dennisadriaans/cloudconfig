/**
 * Scaffold templates: the starter config and the per-framework mount files
 * that wire the Hono backend into each framework's catch-all route. Generated
 * projects stay deliberately thin — the architecture lives in the package and
 * is inherited via the `createBackend` seams, which every template names so
 * the swap points are discoverable from day one.
 */
import type { Framework } from './detect.js'
import type { RunnerCommand } from './package-manager.js'
import { sanitizeMcpName } from './package-name.js'

/**
 * What `cloudconfig init` writes. Email/password sign-in works without an
 * external identity provider; GitHub can be added when credentials exist.
 */
export const STARTER_CONFIG = `import { defineBackend, model, t } from '@cloudconfig/core'

// Define your data and access rules here; CloudConfig creates the API and typed client.
// Get started from this folder (commands use pnpm):
//   pnpm install      # first time only
//   pnpm db:generate  # create SQL migrations from this config
//   pnpm db:migrate   # apply migrations to the local database
//   pnpm dev          # start your dev server
// After model/field changes, repeat generate + migrate, then restart pnpm dev.
// Try the API at /api/_docs on your dev server.
// Models, fields and access rules: https://cloudconfig.dev/docs/configuration

export const config = defineBackend({
  models: {
    // The singular key "post" creates the posts table and /api/posts routes.
    // id, createdAt and updatedAt are automatic.
    post: model(
      {
        title: t.text().required().label('Title'),
        body: t.textarea(),
        published: t.boolean().default(false),
        author: t.relation('user'),
      },
      {
        // Missing access rules deny access.
        access: {
          // Anyone can read published posts; drafts stay hidden.
          list: ({ where }) => where('published', 'eq', true),
          read: ({ where }) => where('published', 'eq', true),
          // Any signed-in user can create, update or delete any post.
          create: ({ user }) => user != null,
          update: ({ user }) => user != null,
          delete: ({ user }) => user != null,
        },
      },
    ),
  },

  // Optional GitHub sign-in: pnpm exec cloudconfig auth add github
  // Guide: https://cloudconfig.dev/docs/authentication
  auth: {
    emailPassword: true,
    twoFactor: true,
  },

  server: { basePath: '/api', docs: true },

  // Optional deployment settings: https://cloudconfig.dev/docs/deployment
  deploy: {
    // target: 'cloudflare', // cloudflare | vercel | azure
    // domain: 'api.example.com',
  },
})
`

/**
 * A project-scoped MCP config. Claude Code (and other MCP clients that read
 * `.mcp.json`) auto-discovers the server declared here, so after `cloudconfig init` an
 * agent can manage the backend by tool call with no extra setup.
 *
 * The server key is derived from the project's `package.json` `name` (see
 * `sanitizeMcpName`) so multiple CloudConfig apps in one workspace do not collide
 * under a shared `"cloudconfig"` label. The runner matches the project's package
 * manager so the locally-installed `cloudconfig` bin resolves without a network hop.
 */
export function mcpConfigFor(serverName: string, runner: RunnerCommand): string {
  const name = sanitizeMcpName(serverName)
  return `${JSON.stringify(
    {
      mcpServers: {
        [name]: {
          command: runner.command,
          args: runner.args,
        },
      },
    },
    null,
    2,
  )}\n`
}

export interface MountFile {
  path: string
  content: string
}

/**
 * Docblock placed on the generated `app`. Naming the three seams where the
 * backend is constructed is what makes them discoverable from day one.
 */
export const SEAM_DOC = `/**
 * The backend, built from cloud.config.ts.
 *
 * createBackend accepts three optional seams:
 * - getUser resolves the caller yourself; the config's auth block already does this
 * - db picks a SQLite driver from @cloudconfig/core/drivers
 * - data replaces the whole data stack with another ORM or engine
 */`

const NEXT_MOUNT = `import { resolveConfigExport } from '@cloudconfig/core'
import { createBackend } from '@cloudconfig/core/server'
import { configuredDatabase } from '@cloudconfig/core/drivers/configured'
import * as configModule from '@/cloud.config'

const config = resolveConfigExport(configModule, 'cloud.config.ts')

${SEAM_DOC}
const app = createBackend(config, { db: configuredDatabase(config) })

const handler = (req: Request) => app.fetch(req)

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE }
`

export function withConfigFilename(source: string, filename: string): string {
  return source.replaceAll('cloud.config', filename.replace(/\.ts$/, ''))
}

export function mountFileFor(
  framework: Framework,
  configFilename = 'cloud.config.ts',
): MountFile | undefined {
  switch (framework) {
    // Nuxt has no mount file: `@cloudconfig/nuxt` registers the handler (and resolves
    // the driver per request, which a static mount file cannot do).
    case 'next':
      return {
        path: 'app/api/[[...cloudconfig]]/route.ts',
        content: withConfigFilename(NEXT_MOUNT, configFilename),
      }
    default:
      return undefined
  }
}

export const STANDALONE_ENTRY = `import { serve } from '@hono/node-server'
import { resolveConfigExport } from '@cloudconfig/core'
import { createBackend } from '@cloudconfig/core/server'
import { configuredDatabase } from '@cloudconfig/core/drivers/configured'
import * as configModule from './cloud.config.ts'

const config = resolveConfigExport(configModule, 'cloud.config.ts')
${SEAM_DOC}
const app = createBackend(config, { db: configuredDatabase(config) })
const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port })
console.log(\`CloudConfig running on http://localhost:\${port}\`)
console.log(\`Docs at http://localhost:\${port}/api/_docs\`)
`

/** The production entry uses the same config and routes with a per-request D1 binding. */
export const STANDALONE_WORKER = `import { resolveConfigExport } from '@cloudconfig/core'
import { createBackend } from '@cloudconfig/core/server'
import { configuredDatabase } from '@cloudconfig/core/drivers/configured'
import * as configModule from './cloud.config'

const config = resolveConfigExport(configModule, 'cloud.config.ts')
const app = createBackend(config, { db: configuredDatabase(config) })

export default { fetch: (request: Request, env: Record<string, unknown>) => app.fetch(request, env) }
`
