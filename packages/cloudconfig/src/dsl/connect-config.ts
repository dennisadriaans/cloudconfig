/**
 * The `connect` block — CloudConfig Connect.
 *
 * Connect is how an app's users link third-party accounts (GitHub, Slack,
 * Google, a hosted MCP server, …) so server code can call those APIs on their
 * behalf. Tokens live in the project's own database, sealed under a key that is
 * not in it; the OAuth apps are the developer's own. Nothing is brokered by a
 * third party.
 *
 * Like `auth`, this block is plain data: credentials never appear here. Each
 * provider names the environment variables that carry its client id and
 * secret, so the config stays committable and `cloudconfig deploy` can require
 * them by name.
 */

/**
 * First-party providers Connect ships an OAuth flow for. The id is also the
 * callback path segment (`<basePath>/connect/<id>/callback`), so renaming one
 * silently breaks a redirect URI already registered with the vendor.
 */
export const CONNECT_PROVIDER_IDS = [
  'atlassian',
  'discord',
  'github',
  'gitlab',
  'google',
  'hubspot',
  'intercom',
  'linear',
  'microsoft',
  'notion',
  'shopify',
  'slack',
] as const

export type ConnectProviderId = (typeof CONNECT_PROVIDER_IDS)[number]

/** Who a connection belongs to. */
export type ConnectionScope = 'user' | 'workspace'

export interface ConnectProviderConfig {
  /**
   * Scopes a connection may request. A connect request asks for a subset; when
   * it names none, all of these are requested. Omitted means the provider's
   * defaults.
   */
  scopes?: readonly string[]
  /** Env var holding the client id. Defaults to `CONNECT_<PROVIDER>_CLIENT_ID`. */
  clientIdEnv?: string
  /** Env var holding the client secret. Defaults to `CONNECT_<PROVIDER>_CLIENT_SECRET`. */
  clientSecretEnv?: string
  /** HTTPS MCP endpoints allowed to use this provider's OAuth account tokens. */
  mcpServers?: readonly string[]
  /**
   * Which scopes a connection may use. `user` connections act as the person who
   * connected; `workspace` connections are installed for an organization and
   * shared with its members. Defaults to the provider's natural shape.
   */
  allow?: readonly ConnectionScope[]
  /** Provider-specific options (`tenant` for Microsoft, `baseUrl` for self-managed GitLab, …). */
  options?: Record<string, string | number | boolean>
}

/** A generic OAuth 2.0 provider Connect has no built-in definition for. */
export interface ConnectCustomProviderConfig {
  label: string
  authorizeUrl: string
  tokenUrl: string
  revokeUrl?: string
  /** A GET endpoint that answers with the account, used to name the connection. */
  userInfoUrl?: string
  scopes?: readonly string[]
  /** Separator between scopes in the authorize URL. Defaults to a space. */
  scopeSeparator?: string
  /** How the token endpoint expects client credentials. Defaults to `body`. */
  tokenAuth?: 'body' | 'basic'
  /** Send a PKCE challenge. Defaults to true. */
  pkce?: boolean
  clientIdEnv?: string
  clientSecretEnv?: string
  /** HTTPS MCP endpoints allowed to use this provider's OAuth account tokens. */
  mcpServers?: readonly string[]
  allow?: readonly ConnectionScope[]
  /** Extra authorize-URL parameters (`access_type`, `prompt`, …). */
  authorizeParams?: Record<string, string>
}

/** Hosted MCP servers users connect through the server's own OAuth. */
export interface ConnectMcpConfig {
  /**
   * Origins a user may connect, e.g. `https://mcp.linear.app`. Omitted means
   * any public HTTPS origin. Loopback HTTP is accepted in development only.
   */
  allowedOrigins?: readonly string[]
  /** Name shown on the vendor's consent screen. Defaults to the app's host. */
  clientName?: string
}

export interface ConnectConfig {
  /** Dispatch verified app-level webhooks to this automation task before acknowledging delivery. */
  webhooks?: { task: string }
  /** With deploy.automations, run token/key housekeeping every five minutes by default. */
  maintenance?: false | { cron?: string; timeZone?: string; limit?: number }
  /** Built-in OAuth providers. `true` uses the default env vars and scopes. */
  providers?: Partial<Record<ConnectProviderId, boolean | ConnectProviderConfig>>
  /** Additional OAuth 2.0 providers, keyed by the id used in URLs. */
  custom?: Record<string, ConnectCustomProviderConfig>
  /** Let users connect hosted MCP servers. */
  mcp?: boolean | ConnectMcpConfig
  /**
   * Env var holding the sealing keyring. One 32-byte hex key, or several as
   * `id:hex,id:hex` with the first used for new writes. Defaults to
   * `CLOUDCONFIG_CONNECT_KEY`.
   */
  keyEnv?: string
  /** Mount path for the Connect routes. Defaults to `<server.basePath>/connect`. */
  basePath?: string
  /** Organization roles that may add or remove workspace connections. Defaults to owner and admin. */
  managerRoles?: readonly string[]
}

/** Type-anchoring identity function, for keeping the connect block in its own module. */
export function defineConnect(config: ConnectConfig): ConnectConfig {
  return config
}
