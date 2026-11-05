# @cloudconfig/core

`@cloudconfig/core` provides the CloudConfig configuration API, server runtime,
typed client, database drivers, MCP server, and `cloudconfig` command.

CloudConfig turns one TypeScript config into a backend on Cloudflare, Vercel, or Azure: a
database, migrations, validated REST routes, access rules, sign-in, a typed
client, and deployment.

> CloudConfig 0.2 is available on the `latest` npm dist-tag.

## Create a Local API

You need Node.js 22.12 or newer:

```bash
pnpm dlx @cloudconfig/core@latest init blog-api --target standalone
cd blog-api
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000/api/_docs` to explore the generated API.

The reference is a self-contained HTML page that follows your system's light or
dark theme. The model API's OpenAPI 3.1 document is at
`http://localhost:3000/api/openapi.json`; import it into Swagger UI, Postman, or a
client generator. Both URLs follow `server.basePath` and are disabled by
`server.docs: false`.

The specification includes model inputs, response schemas, pagination, filters,
and errors. Write payloads use relation IDs; responses contain nested relation
objects. PUT and PATCH both perform partial updates. Better Auth endpoints and
custom application routes are separate APIs and are not included in this export.

For an export without starting a server, use
`buildOpenApiDocument(compileConfig(config))` from `@cloudconfig/core/server`.

## Define a Model

```ts
import { defineBackend, model, t } from '@cloudconfig/core'

export const config = defineBackend({
  models: {
    post: model(
      {
        title: t.text().required(),
        body: t.textarea(),
        published: t.boolean().default(false),
      },
      {
        access: {
          list: ({ where }) => where('published', 'eq', true),
        },
      },
    ),
  },
})
```

CloudConfig uses this model for the database schema, migrations, validation,
REST routes, typed client, API documentation, and MCP tools.

## Use the Typed Client

```ts
import { createClient } from '@cloudconfig/core/client'
import type { config } from './cloud.config'

const api = createClient<typeof config>({
  baseUrl: 'http://localhost:3000/api',
})

const posts = await api.post.list({ page: 1, pageSize: 20 })
```

## Store Agent Definitions

Agents are an opt-in core capability. Compose the built-in model into your config:

```ts
import { defineBackend } from '@cloudconfig/core'
import { agentModels } from '@cloudconfig/core/agents'

export const config = defineBackend({ models: { ...agentModels } })
```

Generate and apply a migration, then use `api.agent` from the typed client.
Each definition stores Markdown instructions, a provider and model ID, draft/active
status, tool choice, and tool declarations. `runtime` chooses `api`, `codex`, or
`claude`; `localModel` is independent of the API model and defaults to the CLI's
default. Hosts implement CLI execution and use the API provider/model when deployed.
Access is scoped to the signed-in owner;
hooks derive the name from the first Markdown title and enforce ownership.

`createAgentDefinition(name)` supplies the scope, boundaries, decision-making and
tool-use template. `serializeAgentMarkdown` and `parseAgentMarkdown` preserve
settings and full tool declarations in Markdown frontmatter. `agentToolSchema`
exports a declaration for OpenAI Responses, Anthropic or Google; it does not execute
tools. Hosts supply provider credentials, tool handlers and execution.

## Deploy Agents and Automations

Nuxt projects can declare `deploy.agent` and `deploy.automations` in their config.
CloudConfig selects Cloudflare Durable Objects and alarms, Vercel Workflow, or a
separate Azure Durable Functions app with private Blob execution state.
Automation tasks support persisted checkpoints, schedules, delays, event waits,
and cancellation. Connect can hand verified webhooks to durable tasks and run
scheduled token refresh and encryption-key maintenance.

Vercel defaults to an existing Turso database; Cloudflare defaults to D1. Select
D1, Turso, or libSQL explicitly to keep database choice independent of app hosting.
Provide the selected provider's credentials before deployment.

See [Deploy Agents](https://cloudconfig.dev/docs/deployment/agents),
[Deploy Automations](https://cloudconfig.dev/docs/deployment/automations), and
[Platform Support](https://cloudconfig.dev/docs/deployment/support) for runtime
dependencies, storage locations, and remaining limits.

## Deploy with Cloudflare's cf CLI (beta)

When a project has cf's `cloudflare.config.ts` and no Wrangler config,
`cloudconfig deploy` runs `cf build`, preflights and applies D1 migrations, and
uploads the Worker with its secrets through `cf deploy --prebuilt`. Spread the
bindings derived from `cloud.config.ts` into the Worker's environment:

```ts
// cloudflare.config.ts
import { defineConfig } from 'cf/config'
import { cloudflareBindings } from '@cloudconfig/core/cloudflare'
import config from './cloud.config.ts'

export default defineConfig({
  worker: {
    name: 'blog-api',
    compatibilityDate: '2026-10-14',
    entrypoint: './src/index.ts',
    env: { ...cloudflareBindings(config) },
  },
})
```

Nuxt local development, agents, automations, Workflows, Turnstile and remote
libSQL still require `wrangler.jsonc`. See
[Deploy to Cloudflare](https://cloudconfig.dev/docs/deployment/cloudflare#deploy-with-the-cf-cli-beta).

## Generate a backend for Void (preview)

CloudConfig 0.2.0 includes Void entry points under the same MIT license as
CloudConfig. This integration preview targets Void 1.1.11, which requires
Node.js 24.21.0 or newer.

Keep `cloud.config.ts` as the source of models, access rules, auth and Connect.
Derive Void's resource declarations from it:

```ts
// void.config.ts
import { createVoidBackendConfig } from '@cloudconfig/core/void/config'
import { config } from './cloud.config'

export default createVoidBackendConfig(config, {
  name: 'my-void-backend',
  compatibilityDate: '2026-10-14',
})
```

Generate SQL with `cloudconfig db generate` before starting Void. Then prepare
the backend before constructing Void's Vite plugin:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { voidPlugin } from 'void'
import { cloudconfigVoid } from '@cloudconfig/core/void/vite'

export default defineConfig({
  plugins: [await cloudconfigVoid(), voidPlugin()],
})
```

Run `cloudconfig void prepare` to export or inspect these artifacts separately.
Keep the Vite helper for native development identity and Worker export wiring.
Preparation exports compiled application, auth and Connect tables through
`db/schema.ts`, mirrors the authoritative SQL and Drizzle snapshots into
`db/migrations`, declares environment variable names through `env.ts`, and
generates a native API route under `routes/` at `server.basePath` (default `/api`).
An explicit Void `sourceDir` relocates these entry points alongside application
routes and jobs. The generated implementation stays in `.cloudconfig/void/`.
Preparation neither opens a database nor provisions resources or applies SQL.
Void owns those steps. Regenerate SQL with CloudConfig after model changes;
the generated Void schema is not a second migration source.

Void's destructive migration guard still applies to imported history. To approve
reviewed historical SQL without editing an existing CloudConfig ledger, export
`cloudconfigApprovedDestructiveMigrations` from `void.config.ts` as a map of SQL
filenames to their exact lowercase SHA-256 source hashes. Preparation adds Void's
`-- void:allow-destructive` comment only in the generated mirror. Changed source
bytes fail preparation; unapproved files stay unchanged. The same map can be
passed as `approvedDestructiveMigrations` to the Vite helper or preparation API.
This requires a separate mirror: shared authoritative SQL is never annotated.

When `deploy.agent`, `deploy.automations` or `deploy.workflows` is configured,
the Vite helper also attaches generated Worker exports to Void's native entry.
It creates the Cloudflare agent and automation adapters, retains Connect for
automation execution, registers the agent platform, and forwards named Workflow
classes. These declarations reference server-only entry files that must exist
before preparation. The preparation CLI generates the adapter module, but
attaching it requires the Vite helper. This hook currently follows Void 1.1.11's
generated `.void/entry.ts`; SDK updates require a conformance check.

Framework apps retain their existing CloudConfig mount: set
`appType: 'framework'` in the config helper, or pass `--framework` to preparation.
Their framework integration continues to own Worker exports.
The helper positively marks native development requests only for Vite's `serve`
command. Builds and previews retain the production environment, including the
development identity provider's normal refusal outside development.
The Vite helper prepares files at config evaluation time; it does not watch for
schema changes. Restart the development process after regenerating SQL.

Preparation protects authored files and migration directories. If you already
keep authoritative migrations at `db/migrations`, set `db.migrationsDir` to that
path to share the history directly. To retain an existing `env.ts`, pass
`environment: 'external'` to the Vite helper or run
`cloudconfig void prepare --external-env`, then compose the generated validators:

```ts
// env.ts
import { defineEnv, string } from 'void/env'
import { environmentSchema } from './.cloudconfig/void/env'

export default defineEnv({
  ...environmentSchema,
  APPLICATION_KEY: string(),
})
```

Add `.cloudconfig/void/` and generated entry points to `.gitignore` when they are
recreated during setup. The generated environment file contains variable names
and validation rules, not secret values. Upload required values through Void's
secret workflow before deployment. Use distinct resource names for evaluation;
preparation does not transfer data from another deployment.

`createVoidBackend(config)` from `@cloudconfig/core/void/server` is also available
for custom mounts. Forward the original Web request and bindings to
`backend.fetch(request, env)`. The backend uses `config.db.binding` (default `DB`)
and retains validation, access rules, hooks, Better Auth, Connect, OpenAPI and the
API reference.

Use `createVoidServerClient(config, context)` from the same entry point for
typed server operations inside a Void handler or job. Its context carries the
original Web request and the platform bindings.

`createVoidTools(config, context)` from `@cloudconfig/core/void/tools` generates
the schema's tool definitions, operation actions, JSON schemas, Zod schemas and executors. Executors
return `OpResult`, validate arguments and use the public operations boundary,
so server-only fields stay out of tool inputs and results. Supply `getUser` to
use a host identity provider; a configured CloudConfig auth block resolves its
own session by default. The application still owns its model provider and
review/approval policy.

`createVoidMcpServer(config, options)` from `@cloudconfig/core/void/mcp` exposes
the same model vocabulary through MCP. Supply `env` with the D1 binding and
an explicit authentication mode. Network transports require `getUser`; fixed
and anonymous principals remain limited to local transports. The factory does
not install an unauthenticated HTTP endpoint.

The Nuxt Agentic preview carries a version-pinned Void patch to preserve Worker
exports and existing event handlers, compose native jobs and allow an explicit
root Wrangler configuration alongside Void's generated file. Those fixes are
still candidates for upstream contribution; this adapter does not install them.
Keeping an existing CloudConfig root Wrangler file requires that patch and
`preserveWranglerConfig: true` in `createVoidBackendConfig`. Without it, Void's
normal root Wrangler migration requirement still applies.
The patch also supports `preserveEnvExample: true` to retain a documentation-only
`.env.example`. That file is not loaded; other local dotenv variants remain
subject to Void's normal restrictions.

These adapters have TypeScript coverage. Void runtime and deployment conformance
remain pending; do not treat this preview as a full-support release.

## Learn More

- [Introduction](https://cloudconfig.dev/docs)
- [Quickstart](https://cloudconfig.dev/docs/quickstart)
- [Essentials](https://cloudconfig.dev/docs/configuration)
- [Nuxt integration](https://www.npmjs.com/package/@cloudconfig/nuxt)
- [Source and issue tracker](https://github.com/dennisadriaans/cloudconfig)

MIT.
