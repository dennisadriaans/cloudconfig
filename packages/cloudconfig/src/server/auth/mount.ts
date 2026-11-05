/**
 * Wiring better-auth into the CloudConfig backend: the routes, and the identity port.
 *
 * The identity port is the point of the whole feature. `getUser` is what access
 * rules already receive — enabling auth just fills it in, so a rule written as
 * `({ user }) => user != null` starts working without the project writing a
 * single line of session code.
 */
import type { Context, Hono } from 'hono'
import type { ResolvedAuth } from '../../shared/auth-resolve.js'
import type { CompiledBase } from '../compile/index.js'
import { autoDetectDriver } from '../driver-detect.js'
import type { Db, DbProvider } from '../driver.js'
import type { GetUser } from '../ports.js'
import { devIdpApp, DEV_IDP_SEGMENT } from './dev-idp.js'
import { getAuthInstance } from './instance.js'
import type { AuthUser } from './types.js'
import { adminApp } from './admin.js'
import { scimAdminApp, scimApp } from './scim.js'
import { membershipLookup } from './membership.js'

interface AuthEnv {
  Variables: { user: unknown }
  Bindings: Record<string, unknown>
}

export interface AuthRuntime {
  /** Register the auth routes. Must run before the CRUD routes are mounted. */
  mount(app: Hono<AuthEnv>): void
  /** The identity port: resolve the signed-in user from the request cookies. */
  getUser: GetUser<AuthUser>
}

let sessionWarned = false

export function createAuthRuntime(
  base: CompiledBase,
  auth: ResolvedAuth,
  opts: { db?: DbProvider } = {},
): AuthRuntime {
  async function dbFor(ctx: {
    env: Record<string, unknown> | undefined
    request: Request
  }): Promise<Db> {
    const provider = opts.db ?? autoDetectDriver(ctx.env)
    return provider.connect({ env: ctx.env, request: ctx.request })
  }

  async function instanceFor(ctx: { env: Record<string, unknown> | undefined; request: Request }) {
    const db = await dbFor(ctx)
    return getAuthInstance(base, auth, db, ctx)
  }

  const handle = async (c: Context<AuthEnv>): Promise<Response> => {
    const request = c.req.raw
    const instance = await instanceFor({ env: c.env, request })
    return instance.handler(request)
  }
  const membership = membershipLookup(base)

  return {
    mount(app) {
      if (auth.admin) {
        app.route(`${auth.basePath}/manage`, adminApp(base, auth, dbFor, instanceFor))
      }
      if (auth.scim) {
        app.route(`${auth.basePath}/scim-connections`, scimAdminApp(base, auth, dbFor, instanceFor))
        app.route(`${auth.basePath}/scim/v2`, scimApp(base, auth, dbFor))
      }
      // Registered before the catch-all so better-auth does not swallow it.
      // The picker refuses to answer outside development on its own too.
      if (auth.devIdp.enabled) {
        app.route(`${auth.basePath}${DEV_IDP_SEGMENT}`, devIdpApp(auth.devIdp.users))
      }
      // Two routes: `<base>/*` does not match a request for `<base>` itself.
      app.all(auth.basePath, handle)
      app.all(`${auth.basePath}/*`, handle)
    },

    async getUser(request, ctx) {
      try {
        const instance = await instanceFor({ env: ctx?.env, request })
        const session = await instance.api.getSession({
          headers: request.headers,
          ...(auth.admin ? { query: { disableCookieCache: true } } : {}),
        })
        if (!session) return null
        const id = Number(session.user.id)
        if (!Number.isSafeInteger(id) || id <= 0) return null
        if (!auth.organizations) return { ...session.user, id }
        const active = Number(
          (session.session as { activeOrganizationId?: unknown } | null)?.activeOrganizationId,
        )
        // Membership is re-read on every request: a removed member loses
        // organization access now, not when their session expires.
        const organization =
          Number.isSafeInteger(active) && active > 0
            ? await membership(await dbFor({ env: ctx?.env, request }), id, active)
            : null
        return { ...session.user, id, organization }
      } catch (err) {
        // A broken session lookup must not take the whole API down with it: the
        // request continues as anonymous, which access rules already handle.
        if (!sessionWarned) {
          sessionWarned = true
          console.warn(
            `[cloudconfig:auth] could not resolve a session (treating the request as signed out): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
        return null
      }
    },
  }
}
