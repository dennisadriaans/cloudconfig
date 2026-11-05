/**
 * The resolved Connect contract, the counterpart to `auth-resolve.ts`.
 *
 * The runtime, the CLI wizard, `cloudconfig deploy` and `cloudconfig doctor`
 * all need the same env var names, callback URLs and mount path. A redirect
 * URI off by one segment fails only in production, so every default lives
 * here and nowhere else.
 */
import type { AnyConfig } from '../dsl/model-config.js'
import {
  CONNECT_PROVIDER_IDS,
  type ConnectCustomProviderConfig,
  type ConnectProviderConfig,
  type ConnectProviderId,
  type ConnectionScope,
} from '../dsl/connect-config.js'
import { CONNECT_PROVIDERS } from './connect-providers.js'
import { normalizeBasePath, resolveProjectConfig } from './project-config.js'

export const DEFAULT_CONNECT_KEY_ENV = 'CLOUDCONFIG_CONNECT_KEY'
export const DEFAULT_CONNECT_MANAGER_ROLES = ['owner', 'admin'] as const
/** Provider id that hosted MCP connections are stored under. */
export const MCP_PROVIDER_ID = 'mcp'

const CUSTOM_ID = /^[a-z][a-z0-9-]{1,39}$/
const RESERVED_IDS = new Set([
  MCP_PROVIDER_ID,
  'connections',
  'providers',
  'hooks',
  'clients',
  'client',
])

export interface ResolvedConnectEnv {
  key: string
  env: string
  label: string
  secret: boolean
  optional: boolean
}

export interface ResolvedConnectProvider {
  id: string
  label: string
  builtin: boolean
  clientIdEnv: string
  clientSecretEnv: string
  /** Exact endpoints that may receive this provider's OAuth account tokens. */
  mcpServers: readonly string[]
  /** Scopes a connection may request; also the default request. */
  scopes: readonly string[]
  allow: readonly ConnectionScope[]
  options: Readonly<Record<string, string | number | boolean>>
  extraEnv: readonly ResolvedConnectEnv[]
  startFields: readonly { key: string; label: string; placeholder?: string }[]
  /** The full definition, for providers declared under `connect.custom`. */
  custom?: ConnectCustomProviderConfig
}

export interface ResolvedConnect {
  webhookTask?: string
  /** Absolute mount path, e.g. `/api/connect`. */
  basePath: string
  keyEnv: string
  providers: readonly ResolvedConnectProvider[]
  mcp?: { allowedOrigins?: readonly string[]; clientName?: string }
  managerRoles: readonly string[]
  /** Deploy refuses to ship without these. */
  requiredSecrets: readonly string[]
  /** Pushed when set locally; a provider without them reports itself unconfigured. */
  optionalSecrets: readonly string[]
}

/** `github` → `CONNECT_GITHUB_CLIENT_ID` / `CONNECT_GITHUB_CLIENT_SECRET`. */
export function connectEnvNames(id: string): { clientId: string; clientSecret: string } {
  const prefix = connectEnvPrefix(id)
  return { clientId: `${prefix}_CLIENT_ID`, clientSecret: `${prefix}_CLIENT_SECRET` }
}

export function connectEnvPrefix(id: string): string {
  return `CONNECT_${id.replaceAll('-', '_').toUpperCase()}`
}

/** Where a provider sends the browser back. Paste this into the vendor console. */
export function connectCallbackUrl(origin: string, basePath: string, provider: string): string {
  return `${origin.replace(/\/+$/, '')}${basePath}/${provider}/callback`
}

/** Where app-level vendor webhooks (GitHub App, Slack, Linear, …) are delivered. */
export function connectWebhookUrl(origin: string, basePath: string, provider: string): string {
  return `${origin.replace(/\/+$/, '')}${basePath}/hooks/${provider}`
}

function providerOptions(
  value: boolean | ConnectProviderConfig,
): ConnectProviderConfig | undefined {
  if (value === false) return undefined
  return value === true ? {} : value
}

function assertAllow(id: string, allow: readonly ConnectionScope[]): void {
  if (allow.length === 0 || allow.some((scope) => scope !== 'user' && scope !== 'workspace')) {
    throw new Error(`connect.providers.${id}.allow must list "user" and/or "workspace".`)
  }
}

function resolveMcpServers(id: string, servers: readonly string[] = []): readonly string[] {
  return [
    ...new Set(
      servers.map((server) => {
        if (!URL.canParse(server)) {
          throw new Error(`connect provider ${id}: mcpServers must contain HTTPS endpoint URLs.`)
        }
        const endpoint = new URL(server)
        if (
          endpoint.protocol !== 'https:' ||
          endpoint.username ||
          endpoint.password ||
          endpoint.hash
        ) {
          throw new Error(
            `connect provider ${id}: mcpServers must contain HTTPS endpoint URLs without credentials or fragments.`,
          )
        }
        return endpoint.href
      }),
    ),
  ]
}

export function resolveConnect(config: AnyConfig): ResolvedConnect | undefined {
  const connect = config.connect
  if (!connect) return undefined
  if (!config.auth) {
    throw new Error('connect needs signed-in users to own connections — add an auth block too.')
  }
  if (connect.webhooks) {
    if (!connect.webhooks.task || !config.deploy?.automations) {
      throw new Error(
        'connect.webhooks.task requires an automation task and deploy.automations.entry.',
      )
    }
  }
  if (connect.maintenance && !config.deploy?.automations) {
    throw new Error('Scheduled Connect maintenance requires deploy.automations.entry.')
  }
  const maintenanceLimit = connect.maintenance && connect.maintenance.limit
  if (
    maintenanceLimit !== undefined &&
    maintenanceLimit !== false &&
    (!Number.isInteger(maintenanceLimit) || maintenanceLimit < 1 || maintenanceLimit > 500)
  ) {
    throw new Error('connect.maintenance.limit must be between 1 and 500.')
  }

  const providers: ResolvedConnectProvider[] = []
  for (const [key, value] of Object.entries(connect.providers ?? {})) {
    if (!CONNECT_PROVIDER_IDS.includes(key as ConnectProviderId)) {
      throw new Error(
        `connect.providers.${key} is not a built-in provider. Declare it under connect.custom instead.`,
      )
    }
    const options = providerOptions(value as boolean | ConnectProviderConfig)
    if (!options) continue
    const info = CONNECT_PROVIDERS[key as ConnectProviderId]
    const names = connectEnvNames(key)
    const allow = options.allow ?? info.allow
    assertAllow(key, allow)
    const prefix = connectEnvPrefix(key)
    providers.push({
      id: key,
      label: info.label,
      builtin: true,
      clientIdEnv: options.clientIdEnv ?? names.clientId,
      clientSecretEnv: options.clientSecretEnv ?? names.clientSecret,
      mcpServers: resolveMcpServers(key, options.mcpServers),
      scopes: options.scopes ?? info.defaultScopes,
      allow,
      options: options.options ?? {},
      extraEnv: info.extraEnv.map((entry) => ({
        key: entry.key,
        env: `${prefix}_${entry.suffix}`,
        label: entry.label,
        secret: entry.secret === true,
        optional: entry.optional === true,
      })),
      startFields: info.startFields ?? [],
    })
  }

  for (const [id, custom] of Object.entries(connect.custom ?? {})) {
    if (!CUSTOM_ID.test(id) || RESERVED_IDS.has(id)) {
      throw new Error(
        `connect.custom.${id}: use 2-40 lowercase letters, digits and dashes, not a reserved word.`,
      )
    }
    if (CONNECT_PROVIDER_IDS.includes(id as ConnectProviderId)) {
      throw new Error(`connect.custom.${id} shadows a built-in provider. Use connect.providers.`)
    }
    for (const url of [
      custom.authorizeUrl,
      custom.tokenUrl,
      custom.revokeUrl,
      custom.userInfoUrl,
    ]) {
      if (url !== undefined && !/^https:\/\//.test(url)) {
        throw new Error(`connect.custom.${id}: endpoint URLs must use https.`)
      }
    }
    const names = connectEnvNames(id)
    const allow = custom.allow ?? ['user', 'workspace']
    assertAllow(id, allow)
    providers.push({
      id,
      label: custom.label,
      builtin: false,
      clientIdEnv: custom.clientIdEnv ?? names.clientId,
      clientSecretEnv: custom.clientSecretEnv ?? names.clientSecret,
      mcpServers: resolveMcpServers(id, custom.mcpServers),
      scopes: custom.scopes ?? [],
      allow,
      options: {},
      extraEnv: [],
      startFields: [],
      custom,
    })
  }

  const project = resolveProjectConfig(config)
  const basePath = connect.basePath
    ? normalizeBasePath(connect.basePath)
    : `${project.basePath === '/' ? '' : project.basePath}/connect`
  const keyEnv = connect.keyEnv ?? DEFAULT_CONNECT_KEY_ENV
  const mcpOption = connect.mcp
  const mcp = mcpOption === true ? {} : mcpOption || undefined
  for (const origin of mcp?.allowedOrigins ?? []) {
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
      throw new Error(`connect.mcp.allowedOrigins: "${origin}" is not an origin like https://host.`)
    }
  }

  const optionalSecrets = providers.flatMap((provider) => [
    provider.clientIdEnv,
    provider.clientSecretEnv,
    ...provider.extraEnv.map((entry) => entry.env),
  ])

  return {
    basePath,
    keyEnv,
    providers,
    ...(connect.webhooks ? { webhookTask: connect.webhooks.task } : {}),
    ...(mcp ? { mcp } : {}),
    managerRoles: connect.managerRoles ?? DEFAULT_CONNECT_MANAGER_ROLES,
    requiredSecrets: [keyEnv],
    optionalSecrets: [...new Set(optionalSecrets)],
  }
}
