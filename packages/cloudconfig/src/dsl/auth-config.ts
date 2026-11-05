/**
 * The `auth` block of a CloudConfig config — plain data, like the rest of the DSL.
 *
 * Nothing here imports better-auth: a config module has to stay importable from
 * a browser bundle (see the firewall note in `src/index.ts`), so the auth
 * *runtime* lives under `cloudconfig/server` and is loaded lazily on the first
 * request to an auth route.
 *
 * Credentials never appear here. A provider names the two environment variables
 * that carry its client id and secret (`GOOGLE_CLIENT_ID` /
 * `GOOGLE_CLIENT_SECRET` by default), which keeps the config committable and
 * lets `cloudconfig deploy` require those secrets by name without being told twice.
 */
import type { AnyField } from './fields.js'

/**
 * Every social provider better-auth ships. The key is the better-auth provider
 * id verbatim — it is also the callback path segment, so renaming one here
 * would silently break a redirect URI already registered with the provider.
 */
export const AUTH_PROVIDER_IDS = [
  'apple',
  'atlassian',
  'cognito',
  'discord',
  'dropbox',
  'facebook',
  'figma',
  'github',
  'gitlab',
  'google',
  'huggingface',
  'kakao',
  'kick',
  'line',
  'linear',
  'linkedin',
  'microsoft',
  'naver',
  'notion',
  'paypal',
  'polar',
  'railway',
  'reddit',
  'roblox',
  'salesforce',
  'slack',
  'spotify',
  'tiktok',
  'twitch',
  'twitter',
  'vercel',
  'vk',
  'zoom',
] as const

export type AuthProviderId = (typeof AUTH_PROVIDER_IDS)[number]

export interface AuthProviderConfig {
  /** Extra scopes on top of the provider's default. */
  scopes?: readonly string[]
  /** Env var holding the client id. Defaults to `<PROVIDER>_CLIENT_ID`. */
  clientIdEnv?: string
  /** Env var holding the client secret. Defaults to `<PROVIDER>_CLIENT_SECRET`. */
  clientSecretEnv?: string
  /** Provider options forwarded to better-auth verbatim (tenantId, prompt, …). */
  options?: Record<string, unknown>
}

/** A seeded identity the development IdP offers in its account picker. */
export interface DevIdpUser {
  email: string
  name?: string
  image?: string
}

/** Better Auth admin-plugin options that stay serializable in cloud.config.ts. */
export interface AuthAdminConfig {
  /** Existing account IDs that may administer users alongside configured admin roles. */
  userIds?: readonly number[]
  /** Role assigned to new users. Defaults to `user`. */
  defaultRole?: string
  /** Roles with administrator access. Defaults to `admin`. */
  adminRoles?: string | readonly string[]
  /** Default reason recorded when an administrator bans a user. */
  defaultBanReason?: string
  /** Default ban duration in seconds. Omit for bans that do not expire. */
  defaultBanExpiresIn?: number
  /** Impersonation session duration in seconds. Defaults to one hour. */
  impersonationSessionDuration?: number
  /** Message shown to a banned user during sign-in. */
  bannedUserMessage?: string
}

/** Better Auth organization-plugin options supported by the data-only DSL. */
export interface AuthOrganizationsConfig {
  /** Whether signed-in users may create organizations. Defaults to true. */
  allowUserToCreateOrganization?: boolean
  /** Maximum organizations a user may create. Omit for no limit. */
  organizationLimit?: number
  /** Role assigned to an organization's creator. Defaults to `owner`. */
  creatorRole?: 'owner' | 'admin'
  /** Maximum members in an organization. Defaults to 100. */
  membershipLimit?: number
  /** Invitation lifetime in seconds. Defaults to 48 hours. */
  invitationExpiresIn?: number
  /** Maximum pending invitations a member may send. Defaults to 100. */
  invitationLimit?: number
  /** Prevent owners from deleting organizations. */
  disableOrganizationDeletion?: boolean
}

/**
 * Directory provisioning (SCIM 2.0). An organization admin mints a token and
 * pastes it, with the SCIM base URL, into Okta, Entra ID or Google Workspace.
 * Provisioning someone adds them to that organization; deprovisioning removes
 * the membership, which ends their access on the next request. Served by
 * CloudConfig itself, so it runs on D1. Requires `auth.organizations`.
 */
export interface AuthScimConfig {
  /** Lifetime of a minted SCIM token, in days. Defaults to 365. */
  tokenLifetimeDays?: number
  /** Role given to provisioned people. Defaults to `member`. */
  defaultRole?: 'member' | 'admin'
}

/** Optional second factor after the project's normal sign-in, including OAuth. */
export interface AuthTwoFactorConfig {
  /** DashboardStack email service credentials; the API key supplies its registered sender. */
  email?: { apiKeyEnv?: string; serviceUrlEnv?: string }
  /** Passkeys are second factors. Set false to offer email codes only. */
  passkey?: false | { rpID?: string; rpName?: string }
  /** Page that completes a pending sign-in. Defaults to `/two-factor`. */
  redirectPath?: string
}

export interface AuthConfig {
  /** Enable Better Auth's complete user-administration plugin. */
  admin?: boolean | AuthAdminConfig
  /** Enable organizations. The creator becomes an owner by default. */
  organizations?: boolean | AuthOrganizationsConfig
  /** Let users choose email OTP or a passkey as their second factor. */
  twoFactor?: boolean | AuthTwoFactorConfig
  /** SCIM directory provisioning per organization. Requires `organizations`. */
  scim?: boolean | AuthScimConfig
  /** Social providers to enable. `true` uses the default env vars and scopes. */
  providers?: Partial<Record<AuthProviderId, boolean | AuthProviderConfig>>
  /** Enable email + password sign-in. Default false. */
  emailPassword?: boolean
  /** Mount path for the auth routes. Defaults to `<server.basePath>/auth`. */
  basePath?: string
  /** Env var holding the signing secret. Defaults to `BETTER_AUTH_SECRET`. */
  secretEnv?: string
  /** Env var holding the canonical app URL. Defaults to `BETTER_AUTH_URL`. */
  baseUrlEnv?: string
  /**
   * Env var holding the production URL that owns the registered redirect URI.
   * Only read when the OAuth proxy is on. Defaults to `baseUrlEnv`.
   */
  productionUrlEnv?: string
  /** Origins allowed to start a sign-in flow, on top of the app's own. */
  trustedOrigins?: readonly string[]
  /** Extra columns on the user table (roles, plan, …). Migrated like any field. */
  userFields?: Record<string, AnyField>
  /**
   * The local development identity provider: a fake OAuth server so sign-in
   * works before any real credentials exist. NEVER served when
   * `NODE_ENV === 'production'`, whatever this says. Default: on.
   */
  devIdp?: boolean | { users?: readonly DevIdpUser[] }
  /**
   * Route OAuth callbacks through the production deployment so preview URLs
   * work against a single registered redirect URI (better-auth's oAuthProxy).
   * Default: on whenever a production URL is configured and differs from the
   * request origin.
   */
  proxy?: boolean
}

/**
 * Type-anchoring identity function, for keeping the auth block in its own
 * module. Does no validation — like `defineBackend`, importing it must never
 * throw.
 */
export function defineAuth(config: AuthConfig): AuthConfig {
  return config
}
