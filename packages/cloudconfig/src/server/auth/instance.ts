/**
 * Building the better-auth instance from a compiled CloudConfig config.
 *
 * better-auth is an OPTIONAL peer: it is imported dynamically on the first
 * request to an auth route, so a project without an `auth` block never has to
 * install it and never pays for it in a bundle. Every import specifier here is
 * a literal, so bundlers still resolve them statically for a Workers build.
 *
 * The instance is cached per platform `env` object. On Cloudflare that object
 * is stable for the lifetime of an isolate (and carries the D1 binding and the
 * secrets), which makes it the right cache key: a new isolate builds its own
 * instance, and two isolates never share one.
 */
import type { AnyField, FieldSpec } from '../../index.js'
import { getFieldSpec } from '../../dsl/fields.js'
import type { ResolvedAuth } from '../../shared/auth-resolve.js'
import type { CompiledBase } from '../compile/index.js'
import type { Db } from '../driver.js'
import { devIdpProviderConfig, DEV_IDP_SEGMENT } from './dev-idp.js'
import { isDevelopment, readEnv } from './env.js'
import type { AuthInstance } from './types.js'

/**
 * Used only when the environment says it is development and no secret is set,
 * so the first `pnpm dev` signs people in instead of erroring. Sessions signed
 * with it do not survive a change to a real secret, which is the point.
 */
const DEV_SECRET = 'cloudconfig-development-secret-not-for-production'

// A shared Workers env (or Node process) can host several independent backends.
// Scope instances to their compiled backend and database before the environment.
const instances = new WeakMap<
  ResolvedAuth,
  WeakMap<Db, Map<object | undefined, Promise<AuthInstance>>>
>()

const warned = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[cloudconfig:auth] ${message}`)
}

/** FieldSpec kind → the type name better-auth uses for an additional field. */
function additionalFieldType(spec: FieldSpec): string {
  switch (spec.kind) {
    case 'number':
    case 'float':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'multiselect':
      return 'string[]'
    // date/datetime are text columns here, so they stay strings end to end
    default:
      return 'string'
  }
}

/**
 * Extra user columns, described for better-auth. A hidden field is marked
 * `input: false` — that is how a `role` column stays server-assigned instead of
 * something a sign-up payload can set.
 */
function additionalFields(userFields: Record<string, AnyField>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(userFields)) {
    const spec = getFieldSpec(field)
    out[name] = {
      type: additionalFieldType(spec),
      required: false,
      ...(spec.hasDefault ? { defaultValue: spec.defaultValue } : {}),
      ...(spec.hidden ? { input: false } : {}),
    }
  }
  return out
}

function socialProviders(
  auth: ResolvedAuth,
  env: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const provider of auth.providers) {
    const clientId = readEnv(provider.clientIdEnv, env)
    const clientSecret = readEnv(provider.clientSecretEnv, env)
    if (!clientId || !clientSecret) {
      warnOnce(
        `missing:${provider.id}`,
        `${provider.id} is configured but ${provider.clientIdEnv} / ${provider.clientSecretEnv} are not set — the provider is not enabled. Run \`cloudconfig auth add ${provider.id}\`.`,
      )
      continue
    }
    out[provider.id] = {
      clientId,
      clientSecret,
      ...(provider.scopes ? { scope: [...provider.scopes] } : {}),
      ...(provider.options ?? {}),
    }
  }
  return out
}

function resolveSecret(auth: ResolvedAuth, env: Record<string, unknown> | undefined): string {
  const secret = readEnv(auth.secretEnv, env)
  if (secret) return secret
  if (!isDevelopment(env)) {
    throw new Error(
      `[cloudconfig:auth] ${auth.secretEnv} is not set. Sessions cannot be signed without it.\n` +
        `  Generate one with: cloudconfig auth secret\n` +
        `  Then make sure it is listed in deploy.secrets (cloudconfig deploy does this for you).`,
    )
  }
  warnOnce(
    'dev-secret',
    `${auth.secretEnv} is not set — using a development-only signing secret. Run \`cloudconfig auth secret\` before deploying.`,
  )
  return DEV_SECRET
}

/**
 * Whether to route callbacks through the production deployment. Explicit config
 * wins; otherwise it is on as soon as a production URL is known, which is the
 * case that needs it — preview deployments sharing one registered redirect URI.
 */
function useProxy(auth: ResolvedAuth, productionUrl: string | undefined): boolean {
  if (auth.proxy !== undefined) return auth.proxy
  return productionUrl !== undefined
}

async function build(
  base: CompiledBase,
  auth: ResolvedAuth,
  db: Db,
  ctx: { env: Record<string, unknown> | undefined; request: Request },
): Promise<AuthInstance> {
  const [{ betterAuth }, { drizzleAdapter }] = await Promise.all([
    import('better-auth'),
    import('better-auth/adapters/drizzle'),
  ])

  const plugins: unknown[] = []
  if (auth.admin) {
    const { admin } = await import('better-auth/plugins/admin')
    const { adminAc, userAc } = await import('better-auth/plugins/admin/access')
    const adminRoles = toRoleList(auth.admin.adminRoles)
    plugins.push(
      admin({
        ...(auth.admin.userIds ? { adminUserIds: auth.admin.userIds.map(String) } : {}),
        ...(auth.admin.defaultRole ? { defaultRole: auth.admin.defaultRole } : {}),
        ...(adminRoles
          ? {
              adminRoles,
              roles: {
                user: userAc,
                ...Object.fromEntries(adminRoles.map((role) => [role, adminAc])),
              },
            }
          : {}),
        ...(auth.admin.defaultBanReason ? { defaultBanReason: auth.admin.defaultBanReason } : {}),
        ...(auth.admin.defaultBanExpiresIn !== undefined
          ? { defaultBanExpiresIn: auth.admin.defaultBanExpiresIn }
          : {}),
        ...(auth.admin.impersonationSessionDuration !== undefined
          ? { impersonationSessionDuration: auth.admin.impersonationSessionDuration }
          : {}),
        ...(auth.admin.bannedUserMessage
          ? { bannedUserMessage: auth.admin.bannedUserMessage }
          : {}),
      }),
    )
  }
  const offboarding = base.connect ? connectOffboarding(base, db, ctx.env) : undefined
  if (auth.organizations) {
    const { organization } = await import('better-auth/plugins/organization')
    plugins.push(
      organization({
        ...auth.organizations,
        ...(offboarding
          ? {
              organizationHooks: {
                // A departing member's own connections are revoked at the vendor;
                // workspace connections they installed stay with the organization.
                afterRemoveMember: async ({
                  member,
                }: {
                  member: { userId: unknown; organizationId: unknown }
                }) => {
                  await offboarding.member(Number(member.userId), Number(member.organizationId))
                },
                beforeDeleteOrganization: async ({
                  organization: deleted,
                }: {
                  organization: { id: unknown }
                }) => {
                  await offboarding.organization(Number(deleted.id))
                },
              },
            }
          : {}),
      } as Parameters<typeof organization>[0]),
    )
  }
  if (auth.twoFactor) {
    const { createTwoFactorPlugins } = await import('./two-factor.js')
    plugins.push(...(await createTwoFactorPlugins(auth.twoFactor, ctx.env)))
  }
  const productionUrl = readEnv(auth.productionUrlEnv, ctx.env)

  if (useProxy(auth, productionUrl)) {
    const { oAuthProxy } = await import('better-auth/plugins/oauth-proxy')
    plugins.push(oAuthProxy(productionUrl ? { productionURL: productionUrl } : {}))
  }

  const devIdpOn = auth.devIdp.enabled && isDevelopment(ctx.env)
  if (devIdpOn) {
    const { genericOAuth } = await import('better-auth/plugins/generic-oauth')
    const origin = new URL(ctx.request.url).origin
    const authorizeUrl = `${origin}${auth.basePath}${DEV_IDP_SEGMENT}/authorize`
    plugins.push(
      genericOAuth({
        config: [devIdpProviderConfig(authorizeUrl)],
      } as unknown as Parameters<typeof genericOAuth>[0]),
    )
  }

  const social = socialProviders(auth, ctx.env)
  const extra = additionalFields(auth.userFields)
  const baseUrl = readEnv(auth.baseUrlEnv, ctx.env)

  const options = {
    // No baseURL unless one is configured: better-auth then infers it from the
    // request, which is what makes preview deployments and `nuxt dev` on a
    // random port work without another environment variable.
    ...(baseUrl ? { baseURL: baseUrl } : {}),
    basePath: auth.basePath,
    secret: resolveSecret(auth, ctx.env),
    database: drizzleAdapter(db as unknown as Parameters<typeof drizzleAdapter>[0], {
      provider: 'sqlite',
      schema: {
        user: base.models['user']?.table,
        session: base.models['session']?.table,
        account: base.models['account']?.table,
        verification: base.models['verification']?.table,
        ...(auth.twoFactor ? { twoFactor: base.models['twoFactor']?.table } : {}),
        ...(auth.twoFactor && auth.twoFactor.passkey !== false
          ? { passkey: base.models['passkey']?.table }
          : {}),
        ...(auth.organizations
          ? {
              organization: base.models['organization']?.table,
              member: base.models['member']?.table,
              invitation: base.models['invitation']?.table,
            }
          : {}),
      },
    }),
    // CloudConfig's tables use an autoincrement integer primary key, like every other
    // CloudConfig model, so ids stay joinable with `t.relation('user')`.
    advanced: { database: { generateId: 'serial' } },
    // Every CRUD request resolves an identity, so the session is read from a
    // short-lived signed cookie instead of the database on each one. The cost
    // is that a revoked session stays usable for up to a minute.
    session: { cookieCache: { enabled: !auth.twoFactor, maxAge: 60 } },
    ...(auth.trustedOrigins.length > 0 ? { trustedOrigins: [...auth.trustedOrigins] } : {}),
    ...(auth.emailPassword ? { emailAndPassword: { enabled: true } } : {}),
    ...(Object.keys(social).length > 0 ? { socialProviders: social } : {}),
    user: {
      ...(Object.keys(extra).length > 0 ? { additionalFields: extra } : {}),
      deleteUser: { enabled: true },
    },
    ...(plugins.length > 0 ? { plugins } : {}),
  }

  if (devIdpOn) {
    console.log(
      `[cloudconfig:auth] development identity provider mounted at ${auth.basePath}${DEV_IDP_SEGMENT}/authorize (provider id "dev").`,
    )
  }

  return betterAuth(
    options as unknown as Parameters<typeof betterAuth>[0],
  ) as unknown as AuthInstance
}

/** The cached better-auth instance for this platform environment. */
export function getAuthInstance(
  base: CompiledBase,
  auth: ResolvedAuth,
  db: Db,
  ctx: { env: Record<string, unknown> | undefined; request: Request },
): Promise<AuthInstance> {
  const key = ctx.env
  let byDb = instances.get(auth)
  if (!byDb) {
    byDb = new WeakMap()
    instances.set(auth, byDb)
  }
  let byEnv = byDb.get(db)
  if (!byEnv) {
    byEnv = new Map()
    byDb.set(db, byEnv)
  }
  // A failed build (a missing secret, say) must not be cached: the operator
  // fixes the environment and the next request has to try again.
  const cached = byEnv.get(key)
  if (cached) return cached
  const created = build(base, auth, db, ctx).catch((err: unknown) => {
    byEnv!.delete(key)
    throw err
  })
  byEnv.set(key, created)
  return created
}

/**
 * Connect's half of offboarding, loaded only when the project uses Connect.
 * Failures are logged, never thrown: removing a member must not fail because a
 * vendor's revocation endpoint is down — the connection is already unusable.
 */
function connectOffboarding(base: CompiledBase, db: Db, env: Record<string, unknown> | undefined) {
  const run = async (
    work: (connect: import('../../connect/runtime.js').Connect) => Promise<unknown>,
  ) => {
    try {
      const { createConnect } = await import('../../connect/runtime.js')
      await work(createConnect(base, { db, env }))
    } catch (error) {
      console.warn(
        `[cloudconfig:connect] offboarding did not finish: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return {
    member: (userId: number, organizationId: number) =>
      run((connect) => connect.offboard({ userId, organizationId })),
    organization: (organizationId: number) =>
      run((connect) => connect.removeOrganization(organizationId)),
  }
}

/** Accepts roles as an array or as the comma-separated string an env var provides. */
function toRoleList(roles: string | readonly string[] | undefined): string[] | undefined {
  if (!roles) return undefined
  if (typeof roles === 'string') return roles.split(',').map((role) => role.trim())
  return [...roles]
}
