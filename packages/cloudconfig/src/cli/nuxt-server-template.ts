/**
 * The `server/` folder every Nuxt project gets.
 *
 * The module mounts the backend itself, so nothing here is required to run.
 * It exists because a Nuxt developer looks in `server/` first: the README
 * points at the file that configures the backend, and `api/health.ts` is the
 * pattern for adding an endpoint of your own.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runScriptCommand, type PackageManager } from './package-manager.js'

const HEALTH_ENDPOINT = `/**
 * Example of a custom endpoint living beside the generated CloudConfig routes.
 *
 * Nuxt matches this exact path before the module's mount, so GET /api/health
 * reaches this handler while every generated route is untouched. Delete the
 * file if you do not need it.
 */
export default defineEventHandler(() => ({
  status: 'ok',
  time: new Date().toISOString(),
}))
`

function readme(pm: PackageManager): string {
  const migrate = `${runScriptCommand(pm, 'db:generate')} && ${runScriptCommand(pm, 'db:migrate')}`
  return `# server/

Nuxt's server directory. CloudConfig needs nothing in here — the
\`@cloudconfig/nuxt\` module mounts the backend for you. The folder exists so the
two things people usually come looking for are easy to find.

## 1. Where the backend is configured

\`cloud.config.ts\`, in the project root. Models, access rules, sign-in and
deployment all live in that one file. The module reads it at build time and
mounts everything under \`server.basePath\`:

| Route          | Serves                                         |
| -------------- | ---------------------------------------------- |
| \`/api/<model>\` | REST routes generated from \`models\`            |
| \`/api/auth/**\` | sign-in, sessions, account and admin endpoints |
| \`/api/_docs\`   | the generated API reference                    |
| \`/api/openapi.json\` | the generated OpenAPI 3.1 model API specification |

After changing a model, regenerate the schema:

\`\`\`bash
${migrate}
\`\`\`

## 2. How to add your own endpoint

Add a file under \`server/api/\`, exactly as you would in any Nuxt app.
\`api/health.ts\` is a working example serving \`GET /api/health\`.

Nuxt matches an exact route before the module's \`/api/**\` mount, so your
handler wins for its own path and every generated route keeps working — you do
not need to move the backend off \`/api\` to add custom endpoints.

The one thing to avoid is naming a file after a model: \`server/api/notes.ts\`
would shadow the generated \`notes\` routes rather than extend them.

## Replacing identity resolution

Access rules read \`ctx.user\`, which CloudConfig's own \`auth\` block populates. To
resolve the caller yourself instead — an existing session cookie, a gateway
header — add \`server/cloudconfig/user.ts\`:

\`\`\`ts
export default async (request: Request) => {
  const token = request.headers.get('authorization')
  return token ? { id: 1, email: 'someone@example.com' } : null
}
\`\`\`

The module picks that path up automatically and passes it to the backend as
\`getUser\`. Point \`cloudconfig.getUser\` in \`nuxt.config.ts\` at a different file
to override the location.
`
}

/** Writes the server folder, leaving any file the project already has alone. */
export function ensureNuxtServerFolder(projectDir: string, pm: PackageManager): string[] {
  const files: Record<string, string> = {
    'server/README.md': readme(pm),
    'server/api/health.ts': HEALTH_ENDPOINT,
  }

  const written: string[] = []
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(projectDir, relativePath)
    if (existsSync(path)) continue
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    written.push(relativePath)
  }
  return written
}
