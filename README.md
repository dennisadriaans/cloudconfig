# CloudConfig

**One TypeScript config. A backend on your own cloud.**

[Documentation](https://cloudconfig.dev/docs) ·
[Quickstart](https://cloudconfig.dev/docs/quickstart) ·
[npm](https://www.npmjs.com/package/@cloudconfig/core) ·
[Report a Bug](https://github.com/dennisadriaans/cloudconfig/issues/new?template=bug_report.yml) ·
[Request a Feature](https://github.com/dennisadriaans/cloudconfig/issues/new?template=feature_request.yml)

CloudConfig turns `cloud.config.ts` into a database schema, migrations, validated
REST routes, access rules, sign-in, a typed client, and API documentation.
Deploy your backend to Cloudflare, Vercel, or Azure from the same config.

It is built for frontend engineers who need a backend without maintaining a
separate backend project. Use it with Nuxt, Next.js, or a standalone API.

> CloudConfig is in beta. The API may change before the first stable release.

## Start a Local API

You need Node.js 22.12 or newer and pnpm 10 or newer:

```bash
pnpm dlx @cloudconfig/core@beta init blog-api --target standalone
cd blog-api
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000/api/_docs` to explore your generated API.

## Define Your Backend

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

After changing a model, run `pnpm db:generate` and `pnpm db:migrate`.
The schema, API, validation, client types, and documentation follow the same
model definition.

## Use a Typed Client

```ts
import { createClient } from '@cloudconfig/core/client'
import type { config } from './cloud.config'

const api = createClient<typeof config>({
  baseUrl: 'http://localhost:3000/api',
})

const posts = await api.post.list({ page: 1, pageSize: 20 })
```

For Nuxt applications, [`@cloudconfig/nuxt`](https://www.npmjs.com/package/@cloudconfig/nuxt)
provides `useCloudConfig()` and sign-in composables with server rendering support.
Follow the [quickstart](https://cloudconfig.dev/docs/quickstart) for setup.

## Deploy to Your Cloud

Set `deploy.target` to `cloudflare`, `vercel`, or `azure` in `cloud.config.ts`,
then run:

```bash
pnpm exec cloudconfig deploy
```

The CLI builds your app, provisions supported resources, and applies migrations.
See the [deployment guide](https://cloudconfig.dev/docs/deployment) for credentials,
database setup, and the capabilities available on each platform.

## Share Feedback

Use [GitHub Issues](https://github.com/dennisadriaans/cloudconfig/issues) to report
bugs and suggest features. Include package versions and a small reproduction
when reporting a problem. Star this repository to show your support.

This is CloudConfig's public showcase and issue tracker. The implementation is
maintained in a separate private repository; install the published npm packages
to use CloudConfig. Package licenses are included in their npm distributions.
