/**
 * The resolved auth contract — the auth counterpart to `project-config.ts`.
 *
 * Four layers have to agree on the same strings: the runtime that mounts
 * better-auth, the CLI wizard that prints a redirect URI to paste into a
 * provider console, `cloudconfig deploy` that requires the secrets by name, and
 * `cloudconfig doctor`. A redirect URI that is off by one path segment is a sign-in
 * that fails only in production, so every default lives here and nowhere else.
 */
import type { AnyConfig } from '../dsl/model-config.js'
import type {
  AuthConfig,
  AuthAdminConfig,
  AuthOrganizationsConfig,
  AuthScimConfig,
  AuthTwoFactorConfig,
  AuthProviderConfig,
  AuthProviderId,
  DevIdpUser,
} from '../dsl/auth-config.js'
import type { AnyField } from '../dsl/fields.js'
import { normalizeBasePath, resolveProjectConfig } from './project-config.js'

export const DEFAULT_AUTH_SECRET_ENV = 'BETTER_AUTH_SECRET'
export const DEFAULT_AUTH_URL_ENV = 'BETTER_AUTH_URL'

/**
 * The tables CloudConfig's auth owns. Ordered so a migration creates `users` before
 * anything that references it.
 */
export const AUTH_MODEL_NAMES = ['user', 'session', 'account', 'verification'] as const
export const ORGANIZATION_MODEL_NAMES = ['organization', 'member', 'invitation'] as const
export type AuthModelName = (typeof AUTH_MODEL_NAMES)[number]
export type OrganizationModelName = (typeof ORGANIZATION_MODEL_NAMES)[number]

/** The development IdP's provider id, as it appears in URLs and the account row. */
export const DEV_IDP_PROVIDER_ID = 'dev'

/** Path segment the development IdP is mounted under, e.g. `/api/auth/dev-idp`. */
export const DEV_IDP_SEGMENT = '/dev-idp'

export const DEFAULT_DEV_USERS: readonly DevIdpUser[] = [
  { email: 'ada@example.com', name: 'Ada Lovelace' },
  { email: 'grace@example.com', name: 'Grace Hopper' },
  { email: 'alan@example.com', name: 'Alan Turing' },
]

export interface ResolvedAuthProvider {
  id: AuthProviderId
  clientIdEnv: string
  clientSecretEnv: string
  scopes?: readonly string[]
  options?: Record<string, unknown>
}

export interface ResolvedAuth {
  admin?: AuthAdminConfig
  organizations?: AuthOrganizationsConfig
  twoFactor?: {
    email: { apiKeyEnv: string; serviceUrlEnv: string }
    passkey: Exclude<AuthTwoFactorConfig['passkey'], undefined>
    redirectPath: string
  }
  scim?: Required<AuthScimConfig>
  /** Absolute mount path for the auth routes, e.g. `/api/auth`. */
  basePath: string
  providers: readonly ResolvedAuthProvider[]
  emailPassword: boolean
  secretEnv: string
  baseUrlEnv: string
  productionUrlEnv: string
  trustedOrigins: readonly string[]
  userFields: Record<string, AnyField>
  devIdp: { enabled: boolean; users: readonly DevIdpUser[] }
  /** `undefined` means "decide at runtime from the configured production URL". */
  proxy: boolean | undefined
  /** Every env var a deploy must carry for this configuration to work. */
  requiredSecrets: readonly string[]
}

/** `google` → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. */
export function providerEnvNames(id: AuthProviderId): {
  clientId: string
  clientSecret: string
} {
  const prefix = id.replaceAll('-', '_').toUpperCase()
  return { clientId: `${prefix}_CLIENT_ID`, clientSecret: `${prefix}_CLIENT_SECRET` }
}

/** Where a social provider must redirect back to. Paste this into the console. */
export function providerCallbackUrl(
  origin: string,
  authBasePath: string,
  providerId: string,
): string {
  return `${origin.replace(/\/+$/, '')}${authBasePath}/callback/${providerId}`
}

/** The callback for a `genericOAuth` provider (the development IdP uses this). */
export function genericCallbackUrl(
  origin: string,
  authBasePath: string,
  providerId: string,
): string {
  return providerCallbackUrl(origin, authBasePath, providerId)
}

function providerConfig(value: boolean | AuthProviderConfig): AuthProviderConfig | undefined {
  if (value === false) return undefined
  return value === true ? {} : value
}

/** Auth is "on" as soon as the config has an `auth` block with anything in it. */
export function resolveAuth(config: AnyConfig): ResolvedAuth | undefined {
  const auth: AuthConfig | undefined = config.auth
  if (!auth) return undefined

  const providers: ResolvedAuthProvider[] = []
  for (const [key, value] of Object.entries(auth.providers ?? {})) {
    const id = key as AuthProviderId
    const opts = providerConfig(value as boolean | AuthProviderConfig)
    if (!opts) continue
    const names = providerEnvNames(id)
    providers.push({
      id,
      clientIdEnv: opts.clientIdEnv ?? names.clientId,
      clientSecretEnv: opts.clientSecretEnv ?? names.clientSecret,
      ...(opts.scopes ? { scopes: opts.scopes } : {}),
      ...(opts.options ? { options: opts.options } : {}),
    })
  }

  // An `auth` block with nothing in it yet is still auth: the development
  // identity provider alone is a working sign-in, which is the point of being
  // able to build the flow before any provider exists.
  const emailPassword = auth.emailPassword === true

  const project = resolveProjectConfig(config)
  const basePath = auth.basePath
    ? normalizeBasePath(auth.basePath)
    : `${project.basePath === '/' ? '' : project.basePath}/auth`

  const secretEnv = auth.secretEnv ?? DEFAULT_AUTH_SECRET_ENV
  const baseUrlEnv = auth.baseUrlEnv ?? DEFAULT_AUTH_URL_ENV

  const devIdpOption = auth.devIdp
  const devUsers =
    typeof devIdpOption === 'object' && devIdpOption.users ? devIdpOption.users : DEFAULT_DEV_USERS

  const requiredSecrets = [secretEnv]
  for (const provider of providers) {
    requiredSecrets.push(provider.clientIdEnv, provider.clientSecretEnv)
  }

  const factor = auth.twoFactor === true ? {} : auth.twoFactor || undefined
  const twoFactor = factor
    ? {
        email: {
          apiKeyEnv: factor.email?.apiKeyEnv ?? 'EMAIL_API_KEY',
          serviceUrlEnv: factor.email?.serviceUrlEnv ?? 'EMAIL_SERVICE_URL',
        },
        passkey: factor.passkey ?? {},
        redirectPath: factor.redirectPath ?? '/two-factor',
      }
    : undefined
  if (twoFactor) {
    if (!twoFactor.redirectPath.startsWith('/') || twoFactor.redirectPath.startsWith('//')) {
      throw new Error('auth.twoFactor.redirectPath must be a local path, such as /two-factor.')
    }
    requiredSecrets.push(twoFactor.email.apiKeyEnv, twoFactor.email.serviceUrlEnv)
  }

  const scim = resolveScim(auth.scim)
  if (scim && !auth.organizations) {
    throw new Error('auth.scim assigns people to organizations — enable auth.organizations too.')
  }

  return {
    basePath,
    ...(twoFactor ? { twoFactor } : {}),
    ...(scim ? { scim } : {}),
    ...(auth.admin ? { admin: auth.admin === true ? {} : auth.admin } : {}),
    ...(auth.organizations
      ? { organizations: auth.organizations === true ? {} : auth.organizations }
      : {}),
    providers,
    emailPassword,
    secretEnv,
    baseUrlEnv,
    productionUrlEnv: auth.productionUrlEnv ?? baseUrlEnv,
    trustedOrigins: auth.trustedOrigins ?? [],
    userFields: auth.userFields ?? {},
    devIdp: { enabled: devIdpOption !== false, users: devUsers },
    proxy: auth.proxy,
    requiredSecrets: [...new Set(requiredSecrets)],
  }
}

function resolveScim(value: AuthConfig['scim']): Required<AuthScimConfig> | undefined {
  if (!value) return undefined
  const options = value === true ? {} : value
  const tokenLifetimeDays = options.tokenLifetimeDays ?? 365
  if (!Number.isInteger(tokenLifetimeDays) || tokenLifetimeDays < 1 || tokenLifetimeDays > 3650) {
    throw new Error('auth.scim.tokenLifetimeDays must be a whole number of days from 1 to 3650.')
  }
  return { tokenLifetimeDays, defaultRole: options.defaultRole ?? 'member' }
}
