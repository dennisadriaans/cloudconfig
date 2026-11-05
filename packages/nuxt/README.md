# @cloudconfig/nuxt

`@cloudconfig/nuxt` mounts a CloudConfig backend in Nuxt and provides typed
composables for data and sign-in.

> Install the official release with the `latest` npm dist-tag. Keep core and Nuxt
> on matching versions.

## Add CloudConfig to a Nuxt App

Run the CLI from your Nuxt application directory:

```bash
npx -p @cloudconfig/core@latest cloudconfig init \
  --target nuxt \
  --cloudflare
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm typecheck
```

The initializer adds the module, creates `cloud.config.ts`, and configures
local SQLite. The `--cloudflare` option also prepares the Nuxt Worker build and
`wrangler.jsonc`.

## Read Data in a Nuxt Page

The module auto-imports `useCloudConfig()`. Pass the config type to get a client
that follows your models:

```vue
<script setup lang="ts">
import type { config } from '~~/cloud.config'

const api = useCloudConfig<typeof config>()
const { data: posts } = await useAsyncData('posts', () => api.post.list())
</script>
```

During server rendering, the composable calls the backend inside Nitro and
forwards the request cookies. In the browser, it calls the generated REST API.

## Use Sign-In

When `cloud.config.ts` contains an `auth` block, the module also
auto-imports `useCloudConfigAuth()`:

```vue
<script setup lang="ts">
const auth = useCloudConfigAuth()

await auth.signIn.email({
  email: 'ada@example.com',
  password: 'correct-horse-battery-staple',
})
</script>
```

The signed-in user is available to the access rules in your config.

## Deploy Durable Workloads

Set `deploy.target` to `cloudflare`, `vercel`, or `azure` in `cloud.config.ts`.
The module selects the matching Nitro preset. Declare `deploy.agent: { entry }`
or `deploy.automations: { entry, schedules }` to bind the selected cloud's native
execution system. Install its optional runtime dependencies before building.

Authenticated server routes use `useCloudConfigAgents(event)` or
`useCloudConfigAutomations(event)` with scopes derived from the session.
`cloudconfig deploy` provisions native execution and synchronizes declared
automation schedules after publication. Development uses process-local memory.

Vercel defaults to Turso; Cloudflare defaults to D1. See
[Deploy Agents](https://cloudconfig.dev/docs/deployment/agents),
[Deploy Automations](https://cloudconfig.dev/docs/deployment/automations), and
[Platform Support](https://cloudconfig.dev/docs/deployment/support) for setup and limits.

## Change the Module Paths

Most applications do not need module options. Use them when the config or a
custom identity resolver lives somewhere else.

Use `cloud.config.ts`; the legacy `cloudconfig.config.ts` name is also supported,
including with a custom path. Without a custom path, the module checks the project
root in that order, matching the CLI. Keep one config file. Both a named
`export const config = defineBackend(...)` and `export default defineBackend(...)`
work without exporting both. The generated starter uses the named export.

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@cloudconfig/nuxt'],
  cloudconfig: {
    config: 'cloud.config.ts',
    getUser: 'server/cloudconfig/user.ts',
    client: true,
  },
})
```

The API mount path, local database file, and D1 binding belong in
`cloud.config.ts`. This keeps the CLI and Nuxt runtime on the same
configuration.

## Share Feedback

Report bugs and request features in the
[public issue tracker](https://github.com/dennisadriaans/cloudconfig/issues).
