/**
 * Agent instruction files written by `cloudconfig init`. Coding agents read AGENTS.md
 * and the skill runbooks under `.agents/skills/` to work with a CloudConfig project.
 */
export const AGENTS_MD = `# AGENTS.md

This is a CloudConfig project. One \`cloud.config.ts\` is the source of truth for
models, validation, access rules, REST routes, the typed client, SQL schema, and docs.

Use a named \`export const config = defineBackend(...)\` (the starter convention)
or a default export. The legacy \`cloudconfig.config.ts\` filename also works;
\`cloud.config.ts\` wins if both exist. Keep one config file.

**Prefer editing the config + CLI over hand-writing route handlers or SQL.**

| When you need to… | Do this | Detail |
| --- | --- | --- |
| Create or deploy a Nuxt app | Read the fixed setup path | [\`cloudconfig-nuxt-setup\`](.agents/skills/cloudconfig-nuxt-setup/SKILL.md) |
| Understand the project surface | Read this file, then the overview skill | [\`cloudconfig-overview\`](.agents/skills/cloudconfig-overview/SKILL.md) |
| Add or change a model / field | Edit \`cloud.config.ts\`, then migrate | [\`cloudconfig-models\`](.agents/skills/cloudconfig-models/SKILL.md) |
| Call the API from code | Use \`createClient<typeof config>\` | [\`cloudconfig-sdk\`](.agents/skills/cloudconfig-sdk/SKILL.md) |
| Control the project from an agent host | Run \`cloudconfig mcp\` (MCP tools) | [\`cloudconfig-mcp\`](.agents/skills/cloudconfig-mcp/SKILL.md) |
| Add sign-in | \`cloudconfig auth add github\` (never hand-roll sessions) | [\`cloudconfig-auth\`](.agents/skills/cloudconfig-auth/SKILL.md) |
| Call GitHub, Slack, Google, an MCP server… as a user | \`cloudconfig connect add github\` (never store tokens yourself) | [\`cloudconfig-connect\`](.agents/skills/cloudconfig-connect/SKILL.md) |
| Deploy to Cloudflare, Vercel or Azure | \`cloudconfig deploy\` (never hand-run wrangler) | [\`cloudconfig-deploy\`](.agents/skills/cloudconfig-deploy/SKILL.md) |
| Generate / apply migrations | \`cloudconfig db generate\` / \`cloudconfig db migrate\` | overview skill |
| Diagnose setup gaps | \`pnpm doctor\` (or \`cloudconfig doctor\`) | overview skill |
| Run the API locally | \`cloudconfig dev\` (standalone) or the framework mount | overview skill |

Do **not** hand-write Drizzle tables, CRUD route handlers, or a parallel client —
they drift from the config. Extend models and rules in \`cloud.config.ts\` only.

Package scripts typically wrap the \`cloudconfig\` CLI (\`pnpm db:generate\`, \`pnpm doctor\`, \`pnpm dev\`, …).
`

export const SKILL_OVERVIEW = `---
name: cloudconfig-overview
description: How to work in a CloudConfig project — config, CLI, REST, client, MCP. Read before adding models, routes, or hand-written SQL.
---

# CloudConfig overview

## Source of truth

\`cloud.config.ts\` defines models with \`defineBackend\`, \`model\`, and \`t.*\` fields.
Use \`cloud.config.ts\` in the project root. The CLI and Nuxt module also accept
\`cloudconfig.config.ts\` for existing projects; \`cloud.config.ts\` takes precedence.
Keep the starter's named \`config\` export, or use a default export; do not require both.
CloudConfig derives REST routes, typed client types, SQL migrations, Swagger UI, and OpenAPI from it.
Swagger UI is at \`/api/_docs\`; the OpenAPI 3.1 model API specification is at
\`/api/openapi.json\`. Both follow \`server.basePath\` and are disabled by \`server.docs: false\`.
The OpenAPI export describes model CRUD, not Better Auth or custom application routes.
Standalone also serves Swagger UI at \`/\` unless an explicit homepage is registered.
Standalone ships the API and Swagger UI without an admin panel.
Add \`dashboard/index.html\` to set a homepage for \`cloudconfig dev\`.

## CLI

| Command | Purpose |
| --- | --- |
| \`cloudconfig --version\` | Report the installed core package version |
| \`cloudconfig init\` | Scaffold config and mount; \`--template dashboard\` adds the auth starter config and, for Nuxt, the dashboard UI |
| \`cloudconfig doctor\` (\`pnpm doctor\`) | Check config, mount, dependencies, native workload entries/SDKs/cron, host file limits, migrations, and pending local ledger |
| \`cloudconfig db generate\` | Diff config → SQL migration (drizzle-kit via shim) |
| \`cloudconfig db migrate\` | Apply local SQLite migrations; \`--remote\` follows D1, Turso, or libSQL; errors if generate has not been run yet |
| \`cloudconfig db status\` (\`pnpm db:status\`) | Pending migrations (\`--remote\` also reports remote drift and tamper) |
| \`cloudconfig deploy\` | Validate secrets, build for the host, prepare data services, preflight and apply remote migrations, then publish with runtime secrets (\`--dry-run\` previews) |
| \`cloudconfig dev\` | Standalone dev server + Swagger UI with an Open Drizzle Studio button (\`--no-studio\` to disable Studio) |
| \`cloudconfig mcp\` | MCP stdio server (schema + CRUD for agents) |
| \`cloudconfig void prepare\` | Export the backend for Void without starting a server or applying migrations; use \`--framework\` for framework mounts, \`--external-env\` for authored environment schemas, and the \`cloudconfigVoid()\` Vite helper to attach native agent/Workflow exports |

## Inspect the local database

In standalone projects, run \`cloudconfig dev\` and click **Open Drizzle Studio**
in Swagger UI at \`/\` or \`/api/_docs\`. Click **Close Drizzle Studio** or press
Escape to hide the panel. Nuxt development apps use the bottom-center database
icon. Both open \`db.local\` (default \`.cloudconfig/dev.db\`), including auth tables. Studio starts
on the first click, uses a separate loopback port per server, and stops when the
development server closes. It edits data directly, bypassing API rules and hooks.

Use localhost. If the panel cannot connect, open Studio in a new tab and allow
local network access. Install \`drizzle-kit\` and \`better-sqlite3\` if missing;
apply migrations before opening Studio. No separate schema or Studio config is
needed. Nuxt can opt out with \`cloudconfig: { studio: false }\`; standalone uses
\`cloudconfig dev --no-studio\`. Production builds/entries do not mount the toolbar
or launcher. Do not add an app-level launcher or expose Studio on a remote host.

## Surfaces agents can use

1. **Config + CLI** — change models, migrate, run.
2. **REST API** — same route shape per model under \`server.basePath\` (default \`/api\`).
3. **Typed SDK** — \`createClient<typeof config>\` from \`cloudconfig/client\`.
4. **MCP** — \`cloudconfig mcp\` exposes \`describe_schema\` plus five generated CRUD tools
   per model (\`posts_list\`, \`posts_create\`, …) over stdio.

## Anti-patterns

- Hand-writing Drizzle schema next to the config
- Custom CRUD routes that duplicate CloudConfig routes
- Codegen clients that ignore \`typeof config\`

## Local database (standalone / frameworks)

An auth-only app works with \`models: {}\`: the \`auth\` block generates its own
users, accounts, sessions, and verification tables, plus organization tables
when enabled. No placeholder post model is needed. Generate and migrate from
\`cloud.config.ts\` using the same current core package that the Nuxt module uses.

New projects include \`pnpm-workspace.yaml\` with \`allowBuilds\` for
\`better-sqlite3\`, \`esbuild\`, \`sharp\`, \`vue-demi\`, and \`workerd\` (pnpm 10.26+).
Existing pnpm configuration is preserved, including parent workspaces. If pnpm
reports ignored builds, run \`pnpm approve-builds\` and select the needed packages,
then \`pnpm rebuild better-sqlite3\` before retrying \`pnpm db:migrate\`.
A missing \`better_sqlite3.node\` binding means the native install script did not
complete; installing the package alone is not enough.

\`cloudconfig init\` merges missing \`db:generate\` / \`db:migrate\` / \`db:status\` /
\`doctor\` / \`mcp\` scripts (plus standalone \`dev\` / \`start\` / \`deploy\`) and
\`better-sqlite3\` / \`drizzle-kit\` into \`package.json\` (existing keys are left
alone). Framework mounts (Nuxt / Next) wire
\`createBackend(config, { db: sqliteFile(...) })\` pointing at
\`.cloudconfig/dev.db\`. On Nuxt / Next it also marks \`better-sqlite3\` external in
\`next.config.*\` (\`serverExternalPackages\`) or \`nuxt.config.*\`
(\`nitro.externals\`) so the native module is not bundled. Run \`pnpm install\`
(or your PM), then \`pnpm db:generate && pnpm db:migrate\` before the first
request. If the peer is missing at runtime, \`cloudconfig\` still starts (\`init\` /
\`--help\` work); migrate / \`dev\` / \`mcp\` print an install hint instead of a
raw \`ERR_MODULE_NOT_FOUND\`. For Cloudflare D1, swap the driver (or forward
the Workers \`env\` binding) — see \`cloudconfig/drivers/*\`. Standalone init
also writes \`worker.ts\` and \`wrangler.jsonc\`; its first deploy generates the
initial migration and provisions D1.
`

export const SKILL_MODELS = `---
name: cloudconfig-models
description: Add or change CloudConfig models and fields in cloud.config.ts, then generate and apply migrations.
---

# Models and fields

The dashboard starter (Nuxt or standalone) includes a commented \`post\` model
in \`cloud.config.ts\`. Uncomment both its \`model, t\` import and the model block,
then generate and apply migrations before starting or restarting \`pnpm dev\`.
The example allows public reads of published posts and lets any signed-in user
write any post. Adjust these rules for the app before adding private data.
Open \`/api/_docs\` on the dev server to try the API.
See [models, fields and access rules](https://cloudconfig.dev/docs/configuration).

Edit \`cloud.config.ts\` only. Example:

\`\`\`ts
import { defineBackend, model, t } from '@cloudconfig/core'

export const config = defineBackend({
  models: {
    post: model({
      title: t.text().required(),
      body: t.textarea(),
      published: t.boolean().default(false),
      author: t.relation('user'),
    }),
  },
  server: { basePath: '/api', docs: true },
})
\`\`\`

Common field helpers: \`t.text\`, \`t.textarea\`, \`t.number\`, \`t.float\`, \`t.boolean\`,
\`t.date\`, \`t.datetime\`, \`t.select\`, \`t.multiselect\`, \`t.email\`, \`t.url\`, \`t.json\`,
\`t.relation\`.

Add \`.index()\` to fields that list filters and access rules match on, such as an
\`ownerId\` or a relation; \`.unique()\` fields are indexed already. Indexes change
the schema, so run \`db generate\` afterwards.

## Validate input separately from access

Use a model's \`validate(input, existing)\` option for cross-field input checks.
Return \`{ path, message }[]\`; return \`[]\` when valid, rather than throwing or
putting validation in access rules. Invalid input returns HTTP 400 with field
issues. Access rules still decide who may read or write and hide denied rows.

\`\`\`ts
validate: (input) => Date.parse(String(input.endsAt)) > Date.parse(String(input.startsAt))
  ? []
  : [{ path: 'endsAt', message: 'The end must be after the start.' }],
\`\`\`

Validation runs after before-write hooks and before persistence for REST,
generated agent tools, and server operations. On update, \`input\` merges the
existing fields with the patch; \`existing\` contains the previous fields, or
is \`null\` on create. Relation fields use \`<field>Id\` in both inputs.
Changing only a validator does not require a database migration.
Validated updates compare the persisted snapshot atomically; a concurrent change
returns HTTP 409. Reload the row before retrying a draft. Custom data adapters
must honor the optional expected-values argument to DataAdapter.update.

## Keep storage authority on the server

Use \`.serverOnly()\` for ownership, storage keys, and private indexes. These fields
are excluded from browser inputs, rows, schemas, and generated agent tools;
\`.hidden()\` only affects presentation. Set ownership in before-write hooks.

For uploaded files, configure \`storage\` on the model with required metadata
fields (name, mimeType, size), a required unique server-only text storageKey,
and a required server-only numeric ownerId. Optional \`storage.fields\` maps these
names to existing columns. Uploads assign authoritative metadata; generic
metadata-only creation is refused. Generic deletion also cleans up bytes.
Configure \`deploy.r2\` and \`deploy.r2Binding\`; local storage defaults to
\`.cloudconfig/uploads\`. Do not create a parallel upload/CRUD pipeline.
Use \`storage.fields.text\` plus a server-only field and \`extractText\` for content
indexing. Only this explicitly configured private index participates in search.

## Access is deny by default

An action with no rule is refused. Grant access per model, per action:

\`\`\`ts
post: model(fields, {
  access: {
    list: ({ where }) => where('published', 'eq', true), // public, scoped to rows
    create: ({ user }) => user != null,                  // signed in only
  },
})
\`\`\`

A rule returns \`true\`/\`false\`, or a \`where(...)\` predicate that scopes the rows.
Only opt out globally with \`access: { default: 'allow' }\` on the config when the
whole API is meant to be public.

After schema edits:

\`\`\`bash
cloudconfig db generate
cloudconfig db migrate
\`\`\`

Restart \`cloudconfig dev\` (or the framework server) after migrations. Do not edit generated
shim files under \`.cloudconfig/\` by hand.
`

export const SKILL_SDK = `---
name: cloudconfig-sdk
description: Use the typed CloudConfig client (cloudconfig/client) inferred from typeof config — no codegen.
---

# Typed client SDK

\`\`\`ts
import { createClient } from '@cloudconfig/core/client'
import type { config } from './cloud.config'

const api = createClient<typeof config>({ baseUrl: 'http://localhost:3000/api' })

const posts = await api.post.list({ page: 1, pageSize: 20 })
const post = await api.post.create({ title: 'Hello' })
await api.post.update(post.id, { title: 'Updated' })
await api.post.delete(post.id)
\`\`\`

Model keys on the client are **singular** (\`api.post\`); REST paths use the **plural**
(\`/api/posts\`). Types for create/update/list come from \`typeof config\` — no generate step.

For failed saves, narrow errors with \`error instanceof CloudConfigClientError\`
(imported from \`@cloudconfig/core/client\`) and attach \`error.issues\` to editor
fields by \`path\`. The issues are typed \`{ path, message }[]\`; unrelated errors
have an empty array. Table load failures remain in \`state.error\`, while save
failures retain the client error and its issues in \`state.mutationError\`.
Keep the draft until a save succeeds, and show the error message.

For storage models, call \`api.file.upload(file, { fields: { folder: 'Work' } })\`,
\`api.file.download(id)\`, and \`api.file.delete(id)\`. Upload fields cannot assign
storage-managed values. Nuxt reads custom content paths from the config; other
hosts pass \`storagePaths\` to \`createClient\` when using custom paths.

In Nuxt server handlers, use \`await useCloudConfigServer<typeof config>(event)\`
for typed private fields and direct operations. Other hosts use
\`createServerClient(config, context, { db, getUser })\` from
\`@cloudconfig/core/server\`. Identity and access rules still apply. Explicitly
project public fields before returning a server row. Storage cleanup retries are
available as \`api.file.retryCleanup()\` on this trusted server client.

For server-driven tables, use the packaged controller instead of writing another
fetch loop. In Nuxt:

\`\`\`ts
const table = useCloudConfigTable('posts', api.post, { sortBy: 'createdAt', sortDir: 'desc' })
const { state } = table
await table.ready
\`\`\`

Rows are in \`state.value.result.data\`. Use \`setSearch\`, \`setSort\`, \`setFilters\`,
\`setPage\`, and \`setPageSize\`; create/update/delete refresh the current query.
Give independent views distinct keys. The composable transfers the initial result
through Nuxt's SSR payload, including failed requests and their HTTP status, and
disposes subscriptions when the view unmounts. A permission denial must remain
visible after hydration; access requires an allowed ID or a configured admin role.
Outside Nuxt, use \`createTable(api.post)\`, subscribe to its state, call
\`refresh()\`, then \`dispose()\` on teardown. Never share a controller across requests.

\`createFilters<Row>()\` checks filter fields, operators, and values. HTTP filters
are validated independently; malformed filters return 400. List requests accept
an optional second argument \`{ signal }\` for cancellation.

Sign-in users are a separate auth capability: use \`useCloudConfigAdmin()\` in
Nuxt or \`createAdminClient()\` from \`@cloudconfig/core/client\` as the table source.
Do not declare a duplicate user model or copy account-management routes into apps.
`

export const SKILL_MCP = `---
name: cloudconfig-mcp
description: Run and use the CloudConfig MCP server so agents can inspect schema and perform CRUD via tools.
---

# MCP control plane

## Start

From the project root (after \`cloudconfig db migrate\` so the local db exists):

\`\`\`bash
cloudconfig mcp
\`\`\`

\`cloudconfig init\` already wrote a \`.mcp.json\` registering this command, so most hosts
(Claude Code, Cursor, …) pick the server up when the project opens. The server is
named after **this project**, not after CloudConfig: the key comes from \`package.json\`
\`name\` (falling back to the directory name) with the scope stripped and the rest
lowercased to \`[a-z0-9_-]\`, since hosts reject \`@\` and \`/\` in tool names. So the
model sees \`mcp__my-app__posts_list\`, and multiple CloudConfig apps in one workspace do
not collide. To wire a host by hand:

\`\`\`json
{
  "mcpServers": {
    "my-app": {
      "command": "cloudconfig",
      "args": ["mcp"],
      "cwd": "/path/to/project"
    }
  }
}
\`\`\`

## Security

\`cloudconfig mcp\` is an explicitly anonymous, process-local development server for
\`.cloudconfig/dev.db\`. Stdio provides no HTTP credentials; the host process is
the security boundary. Do not point this command at shared or production data.

Embedded servers must choose an identity mode. Use \`principal\` for a fixed
stdio service identity, \`getUser(request)\` for a network transport, or
\`allowAnonymous: true\` only for process-local development. Network transports
refuse to connect without \`getUser\`; their HTTP mount must validate MCP OAuth
2.1 bearer tokens before passing requests to the transport.

Authentication applies to tool discovery and \`describe_schema\` as well as CRUD.
Access rules and hooks receive the resolved user.

## Tools

Storage models replace their create tool with upload (base64 bytes) and download
(an authenticated URL); delete uses the same byte-cleanup lifecycle. Private fields
are absent from tool schemas and results.

One schema tool, plus the model operation tools — generated from the config, so a
model \`post\` (plural \`posts\`) yields \`posts_list\`, \`posts_get\`, \`posts_create\`,
\`posts_update\`, \`posts_delete\`.

| Tool | Purpose |
| --- | --- |
| \`describe_schema\` | Models, fields, REST endpoints from the config |
| \`<plural>_list\` | Paginated list — \`page\`, \`pageSize\`, \`search\`, \`sortBy\`, \`sortDir\`, \`filters\` |
| \`<plural>_get\` | Read one by \`id\` |
| \`<plural>_create\` | Create — field arguments are typed from the model schema |
| \`<plural>_update\` | Patch by \`id\` — pass only the fields you change |
| \`<plural>_delete\` | Delete by \`id\` |

Create/update tools carry input schemas derived from the model's own validation,
so field names and types show up directly in the tool call — call
\`describe_schema\` first only when you need the wider project map.

Programmatic / embedded use:

\`\`\`ts
import { createMcpServer } from '@cloudconfig/core/mcp'

// Local stdio — anonymous is an explicit opt-in (cloudconfig mcp does this).
createMcpServer(config, { db, allowAnonymous: true })

// Local stdio with a fixed service identity.
createMcpServer(config, {
  db,
  principal: { id: 'local-agent', role: 'service' },
})

// Network / HTTP/SSE — the only mode connect() accepts off-process.
// Each caller is resolved from its own request, same as createBackend.
createMcpServer(config, { db, getUser: (req) => /* … */ })
\`\`\`

Local launchers can call the returned server's \`connectStdio()\` method to use the
host's own SDK transport. Set \`localOnly: true\` when \`getUser\` selects a local
account instead of authenticating a network caller.

Application hosts can compose additional typed tools with \`createMcpToolRegistry()\`
and pass \`tools: registry.tools\` to \`createMcpServer\`. All tools require the
same caller identity by default. Mark only credential-free setup diagnostics
\`public: true\`; when identity is unresolved, only those tools are listed.
Use \`includeTool\` to explicitly replace selected generated tools; name collisions
fail at startup. Custom handlers must use the canonical server client for model
operations so validation, access rules and hooks remain authoritative.
Node-based launchers can load either supported configuration filename through
\`loadProjectConfig(projectDir)\` from \`@cloudconfig/core/project\`.

Prefer MCP or the typed client over inventing ad-hoc HTTP helpers in agent code.
Exactly one of \`getUser\`, \`principal\`, or \`allowAnonymous\` is required;
\`principal\` and \`allowAnonymous\` are rejected on network transports.
`

export const SKILL_DEPLOY = `---
name: cloudconfig-deploy
description: Deploy a CloudConfig project to Cloudflare, Vercel or Azure with \`cloudconfig deploy\` — D1, secrets, remote migrations, custom domain. Read before running wrangler by hand.
---

# Deploying a CloudConfig project

Set \`deploy.target\` in \`cloud.config.ts\` to \`cloudflare\` (the default),
\`vercel\`, or \`azure\`, then run \`cloudconfig deploy\`. Hosting and data are
independent once selected. Vercel defaults to Turso; Cloudflare and Azure default
to D1. Pin \`db.remote.provider\` to \`d1\`, \`turso\`, or \`libsql\` before
switching hosts. Deploy never copies or deletes existing rows, files, the previous
deployment, or DNS. Migrate data separately.

Vercel needs its installed CLI and \`vercel login\` or \`VERCEL_TOKEN\`; Azure needs
its installed CLI, \`az login\`, and an active subscription (check \`az account list\`).
A tenant-only login or an expired free account cannot provision App Service;
activate/select a subscription before deploying. Optional \`deploy.name\`, \`deploy.vercel\`
(scope/project), and \`deploy.azure\` (subscription/resourceGroup/location/sku)
select the destination. Azure uses Node.js 22 App Service, westeurope/B1 by default.
Vercel reports its production alias after publication; generated deployment URLs
may require Vercel login even when the production alias is public.
It packages local builds, so runtime native dependencies must match Azure Linux.
Next uses its official standalone server: deploy sets output: 'standalone' for
standard Next config shapes. Opaque/conflicting configs get a setup instruction.
Monorepo outputFileTracingRoot must include the workspace dependencies; links
outside the runtime artifact block packaging before migrations.

For Vercel's Turso default, create a Turso database first and supply
\`TURSO_DATABASE_URL\` and \`TURSO_AUTH_TOKEN\`. CloudConfig applies migrations
and uploads server credentials; it does not provision Turso. No Wrangler or
Cloudflare account is needed unless the project uses Cloudflare services.
Select Turso explicitly on any host with \`db.remote: { provider: 'turso' }\`.
Override its credential names with \`urlEnv\` and \`tokenEnv\` when needed.

To retain an existing D1 database on Vercel, set
\`db.remote: { provider: 'd1' }\` before upgrading or changing hosts.
For D1 outside Cloudflare, provide \`CLOUDFLARE_ACCOUNT_ID\` and a persistent
\`CLOUDCONFIG_D1_API_TOKEN\` with D1 access (\`CLOUDFLARE_API_TOKEN\` is a fallback).
Wrangler supplies the existing database identity; keep it installed for D1
provisioning and migrations even when app hosting moves. The D1 token is used only
for database operations; Worker deployment keeps its own Wrangler login or
\`CLOUDFLARE_API_TOKEN\`. Standalone Node adapters preserve the public HTTPS origin
behind Vercel/App Service TLS termination so sign-in origin checks stay enabled.
R2 needs
\`CLOUDCONFIG_STORAGE_ACCESS_KEY_ID\` and \`CLOUDCONFIG_STORAGE_SECRET_ACCESS_KEY\`;
its account endpoint and bucket are inferred. The configured database driver
uses local SQLite in development and the resolved provider in production. D1
uses a binding on Workers and HTTPS elsewhere; Turso/libSQL use their remote URL.
Upgrade older explicit sqliteFile/d1 mounts once to
\`configuredDatabase(config)\` from \`@cloudconfig/core/drivers/configured\`.
Nuxt preset selection follows the target even with the legacy cloudflare flag.

For an existing independent libSQL database, use
\`db.remote: { provider: 'libsql' }\` with \`CLOUDCONFIG_DATABASE_URL\` and
\`CLOUDCONFIG_DATABASE_TOKEN\`. It is not provisioned and existing D1 rows are not
copied. Existing S3 storage uses \`storage: { provider: 's3' }\` and the
CLOUDCONFIG_STORAGE_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY settings.
With Turso, R2 still needs its Cloudflare account ID (or an explicit storage
endpoint) independently of the database. PostgreSQL, MySQL, Neon, Supabase,
PlanetScale, Cosmos DB, and AWS-specific database adapters are not supported yet.

Host builds finish before data provisioning/migration. Runtime secrets use stdin
(Vercel) or a private temporary settings file (Azure), never argv. New host dry
runs perform only local validation and no provider calls. Nuxt agent hosts use
native Cloudflare Agents, Vercel Workflow, or Azure Durable Functions. Cloudflare
Workflow classes remain Cloudflare-specific; there is no production memory fallback.
Managed Turnstile stays on Cloudflare. Azure's automatic domain/certificate binding
is not implemented: omit deploy.domain and cut over traffic separately. Update
BETTER_AUTH_URL and OAuth redirect URIs when the public origin changes.
Azure application database/upload adapters remain separate from the native
Storage account used for agent execution.

The remaining sections describe the Cloudflare deployment path.

\`\`\`bash
cloudconfig deploy             # build -> provision -> preflight -> migrate -> deploy -> secrets
cloudconfig deploy --dry-run   # report the whole plan, mutate nothing
cloudconfig db status --remote # the same preflight, read-only
\`\`\`

For a new standalone project, init writes \`worker.ts\` and \`wrangler.jsonc\`, adds
Wrangler, and generates a signing secret. After installing dependencies,
\`cloudconfig deploy\` generates the initial migration if none exists, creates
D1, applies migrations, and deploys the Worker. Wrangler must be authenticated
once with \`wrangler login\` or \`CLOUDFLARE_API_TOKEN\`. Existing social providers
still need their real OAuth credentials.

**Do not run \`wrangler deploy\`, \`wrangler d1 create\`, or \`wrangler d1 migrations apply\`
by hand.** \`cloudconfig deploy\` runs them in an order that is a safety property, and
skipping it is how a migrated database ends up in front of the old code.

### Projects with \`cloudflare.config.ts\` (cf beta)

When the project has cf's \`cloudflare.config.ts\` and no Wrangler config,
\`cloudconfig deploy\` uses the \`cf\` CLI: \`cf build\`, then the D1 preflight and
migrations, then \`cf deploy --prebuilt\` with the secrets. Spread
\`cloudflareBindings(config)\` from \`@cloudconfig/core/cloudflare\` into
\`worker.env\`; cf uploads only declared secrets. Domains and routes live in
\`cloudflare.config.ts\`. Agents, automations, Workflows, Turnstile and remote
libSQL still need \`wrangler.jsonc\`, and so does Nuxt local development.

## What the config owns

\`\`\`ts
export const config = defineBackend({
  models: { /* … */ },
  deploy: {
    domain: 'api.example.com',   // omit for the generated workers.dev URL
    d1: 'my-app-db',             // defaults to db.name, then <worker>-db
    r2: 'my-app-files',          // omit for no bucket
    secrets: ['STRIPE_KEY'],     // required at deploy time, from env / .env
    turnstile: true,             // optional: managed widget, public key, secret sync
  },
})
\`\`\`

Auth provider credentials do not go in \`secrets\`: \`cloudconfig auth add <provider>\`
records them and deploy requires and pushes them automatically.

## Agents and Workflows

Declare one portable host with \`deploy.agent: { entry: 'server/cloudconfig/agents.ts' }\`.
It default-exports defineAgentHost(...). Nuxt binds useCloudConfigAgents(event) to
the native production adapter and to process-local memory in development.

Cloudflare needs \`agents@0.27.0\`. Nuxt generates its Agent export, binding and
SQLite migration. Defaults are CloudconfigAgent / CLOUDCONFIG_AGENTS /
cloudconfig-agents-v1; customize them under deploy.agent.cloudflare. Keep the
class identity and migration tag stable. The older deploy.agents declaration
with entry/className/binding/migrationTag is also accepted.

Vercel needs \`workflow@^5.2.2\` and currently requires Nuxt for automatic builds.
The module configures workflow/nuxt and writes compiler source under .cloudconfig.
Vercel Workflow continues bounded activities and durable schedules; private run
records, receipts and leases use the configured production database. Provider
keys never enter Workflow arguments/history. Validate that the build emits
.vercel/output/diagnostics/workflows-manifest.json with the agent workflows.

Azure needs \`@azure/functions@^4.16.5 durable-functions@^3.6.0 @azure/storage-blob@^12\`.
Deploy builds a separate native Function app, provisions private Storage, reuses
the App Service plan, uploads code/settings, and supplies its endpoint and
Function key to the web app. deploy.azure.agents.appName/storageAccount override
derived names. Keep the host portable: Nuxt aliases and auto-imports are not
available in the Function process. Blob ETags fence concurrent activity writes;
Durable Functions external events resume approvals and durable timers schedule work.

Each native activity executes at most one new model/tool call. Completed receipts
replay; an ambiguous external dispatch fails for review instead of being repeated.
Tools should forward their stable idempotencyKey and activity signal. Changing
hosts does not migrate in-flight execution history; drain or retain old runs and
recreate schedules. See https://cloudconfig.dev/docs/deployment/agents.

## Portable Automations

Declare \`deploy.automations: { entry: 'server/cloudconfig/automations.ts', schedules }\`.
The entry default-exports defineAutomationHost({ authorize, tasks }) from
\`@cloudconfig/core/automations\`. Automatic deployment currently requires Nuxt.
The same runtime dependencies above serve both agents and jobs; Azure hosts both
in one private Function app. Nuxt exposes useCloudConfigAutomations(event), with
runs(scope).start/status/resume/signal/cancel and platform.schedule(key, value).
Derive scope from the authenticated session and recheck permissions in authorize.
Within native callbacks pass the activity env to getAutomationPlatform(env) or
getAgentPlatform(env); both ports are bound in Cloudflare alarms, Vercel steps,
and Azure activities. Use portable explicit imports in host modules.

Tasks use context.step(name, action) for stable checkpoints, context.sleep(name, ms),
and context.waitForEvent(name). Payloads/results must be JSON values. Completed
actions replay; ambiguous non-idempotent dispatches fail for review. Explicit
idempotent retries require a repeat-safe service and stable idempotencyKey.
Forward signal; keep each action under three minutes and jobs under 1,000 checkpoints.
Signals buffer the first payload for each name; cancellation stops future actions.

Static schedules use five-field cron and IANA time zones. Deploy creates an ignored
CLOUDCONFIG_AUTOMATION_ADMIN_KEY, uploads it privately, publishes, then calls the
authenticated /_cloudconfig/automations/configure endpoint. No app visit is needed.
Unchanged schedules keep their due time; removed static schedules stop. Protected
Vercel deployments need VERCEL_AUTOMATION_BYPASS_SECRET locally or in CI. Dry runs
create no management key and never call this endpoint. If synchronization fails,
the CLI reports an already-published app and asks to fix settings then redeploy.

With Connect enabled, deploy.automations adds bounded housekeeping every five
minutes for token refresh, connection and MCP client-secret key rotation, and
abandoned connections. Configure connect.maintenance (cron/timeZone/limit 1–500)
or false. connect.webhooks: { task: 'provider-event' } enqueues verified deliveries
durably before acknowledgement. Tasks receive a public connection summary, never
credentials. Recheck connection permissions when using tokens. Existing inline
onConnectWebhook handlers should stay short. The archived automation editor is
not restored. See https://cloudconfig.dev/docs/deployment/automations.

Vercel's 4.5 MB Function request/response limit also applies to proxied file routes;
keep files below 4 MB with multipart overhead or implement direct object-storage
transfer. Native Azure application Blob uploads and built-in presigned browser
uploads are not implemented. See https://cloudconfig.dev/docs/deployment/support
for remaining platform limits and verification scope.

Declare Cloudflare-specific multi-step jobs in deploy.workflows with entry,
className, binding and name. Deploy reconciles bindings and
appends SQLite migration tags, preserving unrelated objects and migrations.
Conflicting bindings fail before deployment. Built exports are checked before
database migrations. Keep provider keys in server secrets. Route runs through
an authenticated gateway that derives owner and workspace from the session.

## Turnstile

Set \`deploy.turnstile: true\` with \`deploy.domain\` to provision a managed widget.
To adopt one, use \`turnstile: { siteKey: 'your-public-site-key' }\`. Deploy reuses
the widget, ensures the configured hostnames are allowed, writes its public key
to Wrangler vars, passes it to the build, and syncs the matching
\`TURNSTILE_SECRET_KEY\`. No local production secret is needed, and an old local
Turnstile secret cannot override the widget's current secret.

The public variable defaults to \`NUXT_PUBLIC_TURNSTILE_SITE_KEY\` for Nuxt,
\`NEXT_PUBLIC_TURNSTILE_SITE_KEY\` for Next, and \`TURNSTILE_SITE_KEY\` otherwise.
Override it with \`siteKeyBinding\`; add explicit allowed hostnames with \`domains\`.
Deploy does not enable every hostname or remove existing allowed hostnames.
Use a current Wrangler version with Turnstile Read/Edit permissions. Dry runs
only read and report. A widget created before a failed build remains for reuse;
the database and Worker are unchanged. The app still owns rendering and
server-side token validation. For async script loading, await script load and
call \`turnstile.render()\` directly; \`turnstile.ready()\` rejects async/defer scripts.

## Existing apps with their own schema

Deployment also accepts \`models: {}\` without an auth block when the app already
owns its Drizzle schema. Set \`db.migrationsDir\` to the existing SQL migration
directory, including its \`meta/*_snapshot.json\` files. Generate migrations with
the app's schema tooling; do not run \`cloudconfig db generate\` for this setup.
Declare its required Worker secrets in \`deploy.secrets\`. The same provisioning,
migration preflight, target verification, and secret sync apply.

For Nuxt apps without the CloudConfig module, set Nitro's preset to
\`cloudflare_module\` and \`nitro.cloudflare.deployConfig: false\` so the root
Wrangler config remains authoritative after provisioning.

## Custom domain

Set \`deploy.domain\` and run \`cloudconfig deploy\`. The zone must already exist in the
same Cloudflare account; deploy adds the route to the wrangler config and
Cloudflare issues the certificate. Nothing else changes — the same Worker keeps
its workers.dev URL.

For sign-in to keep working on that hostname, point the app's public URL at it
(\`BETTER_AUTH_URL\`) so redirect URIs are generated against the real origin.

## Order, and why it matters

1. Config, auth and secret resolution, optional Turnstile setup, then the app
   build. Turnstile supplies the public key before frontend bundling/prerendering.
2. Read-only preflight: pending migrations, schema **drift**, and **tamper**
   (an applied migration renamed or deleted locally). Drift and missing applied
   migrations block the deploy.
3. Migrations apply, then the live schema is verified against the target.
4. The Worker ships.
5. Secrets ship with the Worker version (\`wrangler deploy --secrets-file\`), so it
   never runs without them. Older wrangler versions push them right after.

A declared secret with no value anywhere blocks the deploy by name rather than
prompting, so CI never hangs.

## When a deploy is blocked

| Report | Fix |
| --- | --- |
| Pending migrations | \`cloudconfig db generate\` and commit the SQL + snapshot |
| Drift | Restore the remote schema baseline; \`--force\` bypasses the gate, unsafely |
| Tamper | Restore the applied migration files from git — do not regenerate them |
| Missing secret | Set it in the environment, \`.env\` |
`

export const SKILL_AUTH = `---
name: cloudconfig-auth
description: Sign-in in a CloudConfig project — the auth block, providers, the development identity provider, and what never to hand-write.
---

# CloudConfig auth

## What CloudConfig owns

An \`auth\` block in \`cloud.config.ts\` makes CloudConfig own sign-in end to end:

\`\`\`ts
export const config = defineBackend({
  models: { /* … */ },
  auth: {
    providers: { github: true },
    userFields: { role: t.select(['member', 'admin']).default('member').hidden() },
  },
})
\`\`\`

That single block gives you:

- \`users\`, \`sessions\`, \`accounts\`, \`verifications\` tables, migrated by the normal
  \`cloudconfig db generate\` / \`cloudconfig db migrate\` flow — no second migration system.
- better-auth mounted at \`<basePath>/auth\` (default \`/api/auth\`).
- \`user\` filled in for every access rule: \`create: ({ user }) => user != null\` starts working.
- \`t.relation('user')\` on any model, for ownership rules like
  \`({ user, where }) => where('authorId', 'eq', user.id)\`.

## Never do these

- Do NOT hand-write session tables, cookie parsing, or a \`getUser\` that reads a JWT.
- Do NOT expose \`/api/users\` — the auth tables are internal on purpose (the
  \`accounts\` table holds provider refresh tokens). They have no REST route and no
  MCP tool, and no access rule can grant one.
- Do NOT put client ids or secrets in \`cloud.config.ts\`. The config names env
  vars (\`GITHUB_CLIENT_ID\`, \`GITHUB_CLIENT_SECRET\`); the values live in
  \`.env\` and are pushed by \`cloudconfig deploy\`.

## Signing in during development

The backend-only starter keeps a local identity provider for work before OAuth
credentials exist. \`cloudconfig dev\` (or any dev server with
\`NODE_ENV=development\`) mounts it with the provider id \`dev\`:

\`\`\`ts
await authClient.signIn.social({ provider: 'dev', callbackURL: '/' })
\`\`\`

It shows an account picker, creates a real user row, and never contacts a real
provider. It is refused whenever the environment is not positively development.
The dashboard template deliberately sets \`devIdp: false\` so its single GitHub
button is the same in every environment; run \`cloudconfig auth add github\` first.

After adding or changing credentials, restart the dev server. \`cloudconfig dev\`
loads local env files only at startup. If sign-in says "Provider not found" even
though \`cloudconfig auth status\` shows credentials are present, the running
server may still be using the environment from before they were added.

## Managing sign-in users

The dashboard template enables
\`auth.admin: { userIds: [], adminRoles: ['admin', 'superuser'] }\`. Sign in, read
your account ID from \`<authBasePath>/get-session\` (\`user.id\`), then put that existing ID in
\`userIds\` and restart the app. IDs belong to a particular database; never
authorize a guessed future ID or automatically promote the first person who
signs in. An existing administrator can also assign the \`admin\` or
\`superuser\` role. The Nuxt dashboard provides the user management UI.
Standalone exposes the management API without a bundled admin panel; use
Drizzle Studio from Swagger UI to inspect the local database during development.

When adding this capability to an existing app, generate/review/apply migrations
first. It adds Better Auth admin columns; \`role\`, \`banned\`, \`banReason\`, and
\`banExpires\` may no longer be declared in \`auth.userFields\`.

The table-compatible \`<authBasePath>/manage/users\` facade and Better Auth's full
\`<authBasePath>/admin/*\` plugin routes share the same authorization. Use
\`createAdminClient()\` / \`useCloudConfigAdmin()\` for roles, bans, password resets,
session revocation, impersonation, and account removal. The ordinary auth tables
remain absent from generic CRUD and MCP, so credentials and tokens are never
exposed as model data.

The dashboard also enables \`auth.organizations: true\`. Organization creators are
members with the \`owner\` role by default. Use \`useCloudConfigOrganizations()\`
for creation, selection, membership, and invitations, and
\`useCloudConfigAccount()\` for profile updates, password changes, linked accounts,
and self-service account deletion.

## Two-factor authentication

Dashboard starters enable \`auth.twoFactor: true\`. Primary sign-in stays GitHub;
users choose email OTP or a passkey in Settings → Security. The package gates
OAuth callbacks on the server and redirects pending sign-ins to \`/two-factor\`.
There is no usable session until the selected factor succeeds. Passkeys belong
to the same account as the primary sign-in and require device PIN or biometrics.

For an existing app, enable \`auth.twoFactor: true\`, install \`better-auth\` and
\`@better-auth/passkey\` version 1.7.7 or newer, then generate and migrate with
the CloudConfig CLI. Do not create a second auth handler or migration system.
Reuse \`useCloudConfigTwoFactor()\`, \`useCloudConfigAccount().getTwoFactorStatus()\`,
the generated \`settings/TwoFactor.vue\`, and \`pages/two-factor.vue\`.

OTP delivery uses \`@dashboardstack/email\`, the shared Cloudflare email service.
Run \`cloudconfig auth email\` to store \`EMAIL_SERVICE_URL\` and \`EMAIL_API_KEY\`
in the project's ignored env file. Use that project's service key; its registered
sender supplies the from address. Deploy automatically requires and syncs both
values. Only positively marked
development environments print codes locally when the sender is missing;
production never prints codes or silently skips verification. Codes are hashed,
expire after five minutes, and allow five attempts. After five failed sign-in
attempts, start sign-in again; resending a code does not reset the limit.
\`cloudconfig auth status\` reports sender setup; \`cloudconfig doctor\` also
checks the passkey dependency. Changing 2FA settings requires a recent sign-in.
Use \`twoFactor: { passkey: false }\` to offer email codes only. The service env
names and passkey RP ID/name are configurable in the same auth block.

## Going live

\`\`\`bash
cloudconfig auth add github     # console link, exact redirect URI, writes the env file
cloudconfig auth secret         # session signing secret
cloudconfig auth status         # what is configured, what is missing
cloudconfig db generate && cloudconfig db migrate
\`\`\`

The redirect URI is \`<origin>/api/auth/callback/<provider>\` — \`cloudconfig auth add\`
prints the exact string for development and production.

Preview deployments do not need their own OAuth client: when a production URL is
set, callbacks are proxied through it, so one registered redirect URI covers
every preview.

## Organizations and SCIM

With \`auth.organizations: true\`, every access rule sees the active organization
and the caller's role, re-read from the \`member\` table on each request:

\`\`\`ts
import { orgRows, hasOrgRole } from '@cloudconfig/core'

access: {
  list: ({ user, where }) => orgRows(user, where), // rows of the active organization
  delete: ({ user, where }) => (hasOrgRole(user, 'owner', 'admin') ? orgRows(user, where) : false),
}
\`\`\`

\`auth.scim: true\` serves SCIM 2.0 at \`<auth>/scim/v2\`. Owners and admins mint a
token with \`POST <auth>/scim-connections\` and paste it into Okta or Entra ID.
Deprovisioning removes the membership, which ends access on the next request and
deletes the person's own Connect connections in that organization.
`

export const SKILL_CONNECT = `---
name: cloudconfig-connect
description: CloudConfig Connect — users and organizations connect third-party accounts (OAuth apps, hosted MCP servers, API keys) that server code then acts through.
---

# CloudConfig Connect

## The rule

Never store a vendor token yourself — no \`accessToken\` column, no token in a JSON
field, no hand-written OAuth callback. Connect owns the flow, seals tokens at rest,
refreshes them, and enforces who may use them.

## Configure

\`\`\`ts
export const config = defineBackend({
  auth: { providers: { github: true }, organizations: true },
  connect: {
    providers: { github: true, slack: true, google: { scopes: ['https://www.googleapis.com/auth/gmail.modify'] } },
    mcp: true, // users may connect hosted MCP servers (Linear, Notion, Sentry, …) with no app registration
  },
})
\`\`\`

\`\`\`bash
cloudconfig connect list         # all built-in providers, MCP, custom OAuth and API-key options
cloudconfig connect add          # choose a provider; non-interactive use lists options without changes
cloudconfig connect add github   # console link, exact callback + webhook URLs, writes the env file
cloudconfig connect key          # the sealing key (CLOUDCONFIG_CONNECT_KEY)
cloudconfig connect status       # what is configured and what is missing
cloudconfig db generate && cloudconfig db migrate
\`\`\`

A provider without credentials shows as unavailable instead of failing, so a
project can enable many and register the OAuth apps it actually ships.

Bare \`cloudconfig connect\` also lists the options, even without a config file.
Gmail uses \`cloudconfig connect add google\`. API-key integrations such as
Cloudflare Email Sending connect through the application's integration UI;
\`connect add\` sets up the built-in OAuth providers.

## Who may use a connection

- \`user\` connections act as the person who connected, inside the organization
  they were made in. Only that person's runs may use them.
- \`workspace\` connections belong to the organization. Any member's runs may use
  them; only owners/admins (\`connect.managerRoles\`) add or remove them. Prefer
  them for bots and installations (GitHub App, Slack) — they outlive the installer.

## Browser

\`\`\`ts
import { createConnectClient } from '@cloudconfig/core/client'
const connect = createConnectClient()
await connect.connect('github', { scope: 'workspace' }) // navigates to GitHub
await connect.connect('mcp', { fields: { server: 'https://mcp.linear.app/mcp' } })
const connections = await connect.list()
\`\`\`

The callback returns to the page that started the flow with \`?connect=connected&connection=<id>\`,
\`?connect=choose\` (pick an installation or site), or \`?connect_error=…\`.

## Server

\`\`\`ts
import { createConnect, actorFromUser } from '@cloudconfig/core/connect'

const connect = createConnect(compileConfig(config), { db, env })
const actor = actorFromUser(user) // or await connect.actorFor({ userId, organizationId }) in a job
const { accessToken, tokenType } = await connect.access(actor, connectionId)
const tools = await connect.mcp(actor, mcpConnectionId).listTools()
\`\`\`

\`access\` refreshes near-expiry tokens under a lease (one refresh even when many
runs ask at once), mints GitHub installation tokens, and throws \`ConnectError\`
with \`code: 'reauthorize'\` when the user must connect again. Run
\`connect.maintain()\` from a cron to refresh ahead of time and re-seal connections
and registered MCP client secrets after a key rotation (\`cloudconfig connect key --rotate\`).
Nuxt projects with deploy.automations get this housekeeping every five minutes
automatically, with a persisted cursor. connect.maintenance can change its cron,
timeZone and limit (1–500), or disable it with false. Preserve older sealing keys
until a full sweep succeeds and inspect failed counts before removing them.

## Webhooks

App-level webhooks go to \`<basePath>/connect/hooks/<provider>\`; Connect verifies the
vendor signature and hands each matching connection to \`onConnectWebhook(handler)\`.
For durable jobs, set connect.webhooks: { task: 'provider-event' } and declare
deploy.automations. Verified deliveries enqueue before acknowledgement; vendor
retries reuse the provider/event/connection/delivery run ID. The host authorizes
every continuation. Keep inline handlers short; run long work inside task steps.
App-defined senders use the connection's own secret (\`webhookSecret\`) with
\`connect.receiveConnectionEvent(uid, request)\`.
`

export const SKILL_NUXT_SETUP = `---
name: cloudconfig-nuxt-setup
description: Create or integrate a Nuxt app with CloudConfig, GitHub sign-in, and a Cloudflare deployment.
---

# Nuxt setup: one fixed path

## Use the right package and a current CLI

The npm package \`cloudconfig\` is unrelated. This backend package is \`@cloudconfig/core\` and
its executable is still named \`cloudconfig\`. Source imports use \`@cloudconfig/core\`,
\`@cloudconfig/core/client\`, and \`@cloudconfig/core/server\`.

Use the current official CLI for setup. It pins matching CloudConfig core and Nuxt
releases in a new project's package.json. Commit the generated lockfile after installation.
Do not run an old globally installed CLI or \`npx cloudconfig\`: either may use
the wrong package or a stale implementation.

## New app

From a directory where you want to create the app:

\`\`\`sh
pnpm dlx @cloudconfig/core@latest init my-app --target nuxt --cloudflare --template dashboard
cd my-app
pnpm install
pnpm exec cloudconfig auth add github
pnpm exec cloudconfig db generate
\`\`\`

Review the generated migration, then:

\`\`\`sh
pnpm exec cloudconfig db migrate
pnpm run typecheck
pnpm exec cloudconfig deploy
\`\`\`

Choose an unused directory/name for an independent deployment. Re-running init
in the same project preserves its config, UI, signing secret, and resource IDs.

New Nuxt projects use npm's \`latest\` tag, so the first install selects the current
stable Nuxt release and records the resolved version in the package manager's lockfile.
Use a Node.js version supported by that Nuxt release. Existing projects keep their
declared package versions when init is re-run.

The explicit dashboard template creates package.json (the latest stable Nuxt + Nuxt UI), a
real sign-in user management, a responsive dashboard with topbar/sidebar navigation,
GitHub registration/sign-in screens, a TypeScript config, ignored env/build files, the Nuxt module
registrations, matching CloudConfig dependencies, a signing secret, and wrangler.jsonc.
Public CLI setup pins the released packages; source-checkout setup links the built local packages.
The account menu switches between topbar (default) and sidebar navigation;
\`useDashboardOrientation()\` persists the choice in an SSR-readable cookie.
Keep main page links in \`DASHBOARD_NAVIGATION\`; access Settings from the user
dropdown. Settings contains Profile, preferences, Organization, and Security
sections on one page at \`/dashboard/settings\`. Use \`SettingsSection\` for its
compact two-column layout. Link directly to \`#organizations\` or \`#security\`;
\`?create=true#organizations\` opens the inline organization form. Keep Settings
out of the main navigation. User management stays in the dashboard users table.
The shell keeps Cmd/Ctrl+K page search without a visible search input.
It carries CloudConfig's fixed design tokens and component theme in generated source;
do not recreate the UI from prompt prose. \`cloudconfig.cloudflare: true\`
lets the module set Nitro's \`cloudflare_module\` preset and
\`cloudflare.deployConfig: false\`; the root Wrangler config stays authoritative
when CloudConfig provisions D1 after the build. Wrangler points at
\`.output/server/index.mjs\`, with \`.output/public\` bound as ASSETS.

## Source checkout development

When contributing from the CloudConfig source repository, prepare its local packages:

\`\`\`sh
pnpm install
pnpm --filter @cloudconfig/core build
pnpm --filter @cloudconfig/nuxt build
\`\`\`

From that repository root, use its built CLI instead of the public command:

\`\`\`sh
node packages/cloudconfig/dist/cli/index.js init examples/my-app --target nuxt --cloudflare --template dashboard
\`\`\`

Then continue from the generated app with the installation and auth commands above.
Source edits do not update \`dist/\` automatically; rebuild the owning package first.

## Existing Nuxt app

From that app's root, run the public CLI:

\`\`\`sh
pnpm dlx @cloudconfig/core@latest init --target nuxt --cloudflare
\`\`\`

Do not add \`--template dashboard\` to a close-to-finished application. Plain
init is the integration path: it installs the backend without writing
application UI. Install the merged dependencies. Existing package scripts,
package versions, app UI, auth config, custom identity resolver, database IDs,
and migrations are not replaced. The template flag is additive and preflights
all of its paths; it refuses customized UI/config files instead of overwriting
or partially applying. Resolve any explicit config conflict the command reports
before continuing. For a customized \`cloud.config.ts\`, ensure its chosen provider
is enabled and run \`pnpm exec cloudconfig auth secret\` if its signing secret is absent.
Do not replace an established identity system merely to match the starter.

Use \`useCloudConfigAuth()\` for GitHub login/logout in the existing UI:

\`\`\`ts
const auth = useCloudConfigAuth()
const session = auth.useSession()
const result = await auth.signIn.social({ provider: 'github', callbackURL: '/dashboard' })
if (result.error) throw new Error(result.error.message ?? 'Sign-in failed.')
// Await success before requesting protected data.
// Sign out with await auth.signOut().
\`\`\`

The dashboard route guard loads the session with forwarded request cookies and
seeds useCurrentUser() before SSR. Reuse that state during hydration; the account
menu applies browser session updates after mounting. For other UI, keep
session-dependent content inside ClientOnly, or implement deliberate SSR session
loading. Use \`session.value.data?.user\` in script and \`session.data?.user\` in Vue
templates. CloudConfig's module owns
the request adapter, D1 binding, and Better Auth mount: do not create a second
catch-all route, auth server, cookie parser, or server/cloudconfig/user.ts for this
basic path. A custom user resolver overrides CloudConfig's built-in session lookup.

## The server/ folder

Every Nuxt init writes \`server/README.md\` and \`server/api/health.ts\`. Nothing
there is required to run — it marks where the backend is configured
(\`cloud.config.ts\`) and how to extend it. Add custom endpoints as ordinary Nuxt
files under \`server/api/\`: an exact route is matched before the module's
\`/api/**\` mount, so a handler coexists with the generated routes instead of
replacing them. Do not move the backend off \`/api\` to make room for one, and do
not name a file after a model — \`server/api/notes.ts\` shadows the generated
\`notes\` routes.

Define resources in the config and call \`useCloudConfig<typeof config>()\` with a
type-only config import. Use \`sortBy\` and \`sortDir\`, not \`sort\`. Assign ownership
in a server hook; scope reads and writes with \`where('ownerId', 'eq', user.id)\`.
Do not allow an update to change a record's owner.

The Nuxt dashboard starts with a users table backed by \`useCloudConfigAdmin()\` and
\`useCloudConfigTable()\`. Configure \`auth.admin.userIds\` with existing account IDs
after sign-in. Its settings page uses \`useCloudConfigAccount()\` for profile and
security, and \`useCloudConfigOrganizations()\` for workspaces; creators become owners
without a second mutation. Keep query lifecycle and auth behavior in the packages;
customize the scaffolded table, columns, forms, and navigation in the app. The standalone
starter shows the generated API reference at \`/\` and \`/api/_docs\` without an
admin panel. Rebuild the core package after source changes before running a
freshly scaffolded standalone app.

Both development integrations include Drizzle Studio. In Nuxt, click the
bottom-center database icon; in standalone, click **Open Drizzle Studio** in
Swagger UI to inspect \`db.local\`. Studio is excluded from production.
Do not scaffold a separate component, Studio config, or
launcher. Disable it with \`cloudconfig: { studio: false }\` in Nuxt or
\`cloudconfig dev --no-studio\` for standalone. See the overview runbook for
connection troubleshooting.

Then follow the same generate → review → local migrate → typecheck → deploy
sequence above. \`cloudconfig deploy\` performs the production build, D1 provisioning,
remote schema preflight/migration, Worker upload, and secret sync.

## Avoid the failure paths

- Do not add first-user promotion, extra OAuth providers, or custom
  request/user adapters before the basic GitHub app works.
- GitHub requires the app owner's credentials. Run \`cloudconfig auth add github\`;
  CloudConfig correctly blocks deployment when required secrets are absent.
- Use \`pnpm exec cloudconfig deploy\` or \`pnpm run deploy\`, never bare \`pnpm deploy\`
  (which is pnpm's own command).
- Do not use \`--skip-build\`, \`--force\`, placeholder database IDs, or hand-run
  Wrangler provisioning/deployment to work around a failed CloudConfig deployment.
- Cloudflare authentication/account access is an external prerequisite. Reuse
  existing authentication, or ask the user to complete \`wrangler login\`.
- Type-check success and a deployment URL do not prove browser sign-up/login or
  live CRUD work. Only claim checks that were actually performed; respect the
  user's verification policy. No prompt can guarantee external-service success.
`

export interface AgentFile {
  path: string
  content: string
}

export function agentFiles(): AgentFile[] {
  return [
    { path: 'AGENTS.md', content: AGENTS_MD },
    { path: '.agents/skills/cloudconfig-nuxt-setup/SKILL.md', content: SKILL_NUXT_SETUP },
    { path: '.agents/skills/cloudconfig-overview/SKILL.md', content: SKILL_OVERVIEW },
    { path: '.agents/skills/cloudconfig-models/SKILL.md', content: SKILL_MODELS },
    { path: '.agents/skills/cloudconfig-sdk/SKILL.md', content: SKILL_SDK },
    { path: '.agents/skills/cloudconfig-mcp/SKILL.md', content: SKILL_MCP },
    { path: '.agents/skills/cloudconfig-auth/SKILL.md', content: SKILL_AUTH },
    { path: '.agents/skills/cloudconfig-connect/SKILL.md', content: SKILL_CONNECT },
    { path: '.agents/skills/cloudconfig-deploy/SKILL.md', content: SKILL_DEPLOY },
  ]
}
