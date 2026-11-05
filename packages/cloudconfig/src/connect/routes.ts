/**
 * Connect's REST surface, mounted by `createBackend` at `connect.basePath`.
 *
 * It manages connections and runs the browser legs of OAuth. It never returns
 * a token: credentials are only reachable server-side through `createConnect`,
 * where the app's own permission checks run first.
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { CloudConfigUser } from '../dsl/filters.js'
import type { CompiledBase } from '../server/compile/index.js'
import type { DbProvider } from '../server/driver.js'
import type { GetUser } from '../server/ports.js'
import { autoDetectDriver } from '../server/driver-detect.js'
import { readEnv } from '../server/auth/env.js'
import { ProviderError } from './http.js'
import { actorFromUser, ConnectError, createConnect, type ConnectActor } from './runtime.js'

interface Env {
  Variables: { user: unknown }
  Bindings: Record<string, unknown>
}

const startSchema = z
  .object({
    scope: z.enum(['user', 'workspace']).optional(),
    scopes: z.array(z.string().min(1).max(200)).max(100).optional(),
    returnTo: z.string().max(2000).optional(),
    fields: z.record(z.string(), z.string().max(2000)).optional(),
    label: z.string().max(120).optional(),
    connection: z.number().int().positive().optional(),
  })
  .strict()

const idSchema = z.coerce.number().int().positive()

export function connectApp(
  base: CompiledBase,
  options: { db?: DbProvider; getUser?: GetUser },
): Hono<Env> {
  const app = new Hono<Env>()

  async function context(c: Context<Env>) {
    const env = c.env as Record<string, unknown> | undefined
    const provider = options.db ?? autoDetectDriver(env)
    const db = await provider.connect({ env, request: c.req.raw })
    return { env, connect: createConnect(base, { db, env }) }
  }

  async function actorOf(c: Context<Env>): Promise<ConnectActor | null> {
    if (!options.getUser) return null
    const user = (await options.getUser(c.req.raw, { env: c.env })) as CloudConfigUser | null
    return actorFromUser(user)
  }

  async function requireActor(c: Context<Env>): Promise<ConnectActor> {
    const actor = await actorOf(c)
    if (!actor) throw new ConnectError('Sign in to manage connections.', 401)
    return actor
  }

  /** Browsers send Origin on cross-site writes; refuse any that is not ours. */
  function assertSameOrigin(c: Context<Env>) {
    const origin = c.req.header('origin')
    if (!origin) return
    const own = new URL(c.req.url).origin
    const trusted = new Set([own, ...(base.auth?.trustedOrigins ?? [])])
    const configured = base.auth ? readEnv(base.auth.baseUrlEnv, c.env) : undefined
    if (configured && URL.canParse(configured)) trusted.add(new URL(configured).origin)
    if (!trusted.has(origin)) throw new ConnectError('Cross-origin request refused.', 403)
  }

  app.use('*', async (c, next) => {
    c.header('cache-control', 'private, no-store')
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !c.req.path.includes('/hooks/')) {
      assertSameOrigin(c)
    }
    await next()
  })

  app.get('/providers', async (c) => {
    const { connect } = await context(c)
    return c.json({ providers: connect.providers() })
  })

  app.get('/connections', async (c) => {
    const actor = await requireActor(c)
    const { connect } = await context(c)
    const provider = c.req.query('provider')
    const kind = c.req.query('kind')
    const scope = c.req.query('scope')
    return c.json({
      data: await connect.list(actor, {
        ...(provider ? { provider } : {}),
        ...(kind === 'oauth' || kind === 'mcp' || kind === 'api_key' ? { kind } : {}),
        ...(scope === 'user' || scope === 'workspace' ? { scope } : {}),
      }),
    })
  })

  app.get('/connections/:id', async (c) => {
    const actor = await requireActor(c)
    const { connect } = await context(c)
    return c.json(await connect.get(actor, idSchema.parse(c.req.param('id'))))
  })

  app.patch('/connections/:id', async (c) => {
    const actor = await requireActor(c)
    const { connect } = await context(c)
    const body = z
      .object({ label: z.string().max(120) })
      .strict()
      .parse(await c.req.json())
    return c.json(await connect.rename(actor, idSchema.parse(c.req.param('id')), body.label))
  })

  app.delete('/connections/:id', async (c) => {
    const actor = await requireActor(c)
    const { connect } = await context(c)
    await connect.remove(actor, idSchema.parse(c.req.param('id')))
    return c.body(null, 204)
  })

  app.post('/connections/:id/target', async (c) => {
    const actor = await requireActor(c)
    const { connect } = await context(c)
    const body = z
      .object({ target: z.string().min(1).max(200) })
      .strict()
      .parse(await c.req.json())
    return c.json(await connect.selectTarget(actor, idSchema.parse(c.req.param('id')), body.target))
  })

  app.get('/connections/:id/tools', async (c) => {
    const actor = await requireActor(c)
    const { connect } = await context(c)
    return c.json({
      tools: await connect.mcp(actor, idSchema.parse(c.req.param('id'))).listTools(),
    })
  })

  app.post('/connections/:id/webhook-secret', async (c) => {
    const actor = await requireActor(c)
    const { connect } = await context(c)
    const body = z
      .object({ rotate: z.boolean().optional() })
      .strict()
      .parse(await c.req.json().catch(() => ({})))
    const id = idSchema.parse(c.req.param('id'))
    const secret = body.rotate
      ? await connect.rotateWebhookSecret(actor, id)
      : await connect.webhookSecret(actor, id)
    return c.json({ secret })
  })

  app.get('/mcp/client.json', async (c) => {
    const { connect } = await context(c)
    c.header('cache-control', 'public, max-age=3600')
    return c.json(connect.clientMetadata(c.req.raw))
  })

  app.post('/hooks/:provider', async (c) => {
    const { connect } = await context(c)
    return connect.dispatchWebhook(c.req.param('provider'), c.req.raw)
  })

  app.post('/:provider/start', async (c) => {
    const actor = await requireActor(c)
    const { connect } = await context(c)
    const body = startSchema.parse(await c.req.json())
    return c.json(
      await connect.start(actor, c.req.raw, {
        provider: c.req.param('provider'),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.scopes ? { scopes: body.scopes } : {}),
        ...(body.returnTo ? { returnTo: body.returnTo } : {}),
        ...(body.fields ? { fields: body.fields } : {}),
        ...(body.label ? { label: body.label } : {}),
        ...(body.connection ? { connection: body.connection } : {}),
      }),
    )
  })

  app.get('/:provider/callback', async (c) => {
    const actor = await actorOf(c)
    const { connect } = await context(c)
    const { redirect } = await connect.complete(actor, c.req.raw, c.req.param('provider'))
    return c.redirect(redirect, 302)
  })

  app.onError((error, c) => {
    if (error instanceof ConnectError) {
      return c.json(
        { error: 'Connect', message: error.message, ...(error.code ? { code: error.code } : {}) },
        error.status,
      )
    }
    if (error instanceof z.ZodError) {
      return c.json(
        { error: 'Bad request', message: error.issues[0]?.message ?? 'Invalid request.' },
        400,
      )
    }
    if (error instanceof ProviderError) {
      return c.json({ error: 'Provider', message: error.message }, 502)
    }
    console.error('[cloudconfig:connect]', error)
    return c.json({ error: 'Connect', message: 'Connect could not complete the request.' }, 500)
  })

  return app
}
