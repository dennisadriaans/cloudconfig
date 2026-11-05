/**
 * Browser client for CloudConfig Connect: list and manage connections, and
 * start the OAuth or MCP flow that adds one. It never sees a token — those
 * stay on the server, reachable only through `@cloudconfig/core/connect`.
 */
import type { ConnectionScope } from '../dsl/connect-config.js'
import type { ConnectionSummary, McpTool, ProviderSummary } from '../shared/connect-types.js'
import type { ClientOptions } from './index.js'
import { sessionRequest } from './request.js'

export type { ConnectionSummary, McpTool, ProviderSummary }

export interface ConnectStartInput {
  scope?: ConnectionScope
  /** A subset of the scopes the app allows for this provider. */
  scopes?: readonly string[]
  /** Same-origin path to come back to. Defaults to the current page. */
  returnTo?: string
  /** Values the provider needs first, e.g. `{ shop }` for Shopify or `{ server }` for MCP. */
  fields?: Record<string, string>
  label?: string
  /** Re-authorize this connection instead of adding another. */
  connection?: number
}

export interface ConnectClient {
  providers(): Promise<ProviderSummary[]>
  list(filter?: {
    provider?: string
    kind?: 'oauth' | 'mcp' | 'api_key'
    scope?: ConnectionScope
  }): Promise<ConnectionSummary[]>
  get(id: number): Promise<ConnectionSummary>
  /** The vendor URL to send the browser to. */
  start(provider: string, input?: ConnectStartInput): Promise<string>
  /** `start`, then navigate there. */
  connect(provider: string, input?: ConnectStartInput): Promise<void>
  rename(id: number, label: string): Promise<ConnectionSummary>
  remove(id: number): Promise<void>
  /** Finish a pending workspace connection by picking an installation or site. */
  selectTarget(id: number, target: string): Promise<ConnectionSummary>
  /** Tools a connected MCP server offers. */
  tools(id: number): Promise<McpTool[]>
  /** The secret app-defined event senders sign with; managers only. */
  webhookSecret(id: number, options?: { rotate?: boolean }): Promise<string>
}

/**
 * Read the result the callback put on the return URL, and strip it so a
 * reload does not show it twice.
 */
export function readConnectResult(
  url: URL = new URL(globalThis.location?.href ?? 'http://localhost/'),
): {
  status: 'connected' | 'choose' | 'error' | null
  connection: number | null
  error: string | null
} {
  const status = url.searchParams.get('connect')
  const error = url.searchParams.get('connect_error')
  const connection = Number(url.searchParams.get('connection'))
  const known = status === 'connected' || status === 'choose' ? status : null
  return {
    status: error ? 'error' : known,
    connection: Number.isSafeInteger(connection) && connection > 0 ? connection : null,
    error,
  }
}

export function createConnectClient(options: ClientOptions = {}): ConnectClient {
  const { json, post } = sessionRequest(options, '/api/connect')

  const send = <T>(path: string, method: string, body?: unknown) =>
    json<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

  const currentPath = () =>
    typeof location === 'undefined' ? '/' : `${location.pathname}${location.search}`

  async function start(provider: string, input: ConnectStartInput = {}): Promise<string> {
    const result = await post<{ url: string }>(`/${encodeURIComponent(provider)}/start`, {
      ...input,
      returnTo: input.returnTo ?? currentPath(),
    })
    return result.url
  }

  return {
    async providers() {
      return (await json<{ providers: ProviderSummary[] }>('/providers')).providers
    },
    async list(filter = {}) {
      const query = new URLSearchParams(
        Object.entries(filter).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ).toString()
      return (await json<{ data: ConnectionSummary[] }>(`/connections${query ? `?${query}` : ''}`))
        .data
    },
    get: (id) => json<ConnectionSummary>(`/connections/${id}`),
    start,
    async connect(provider, input) {
      const url = await start(provider, input)
      if (typeof location !== 'undefined') location.assign(url)
    },
    rename: (id, label) => send<ConnectionSummary>(`/connections/${id}`, 'PATCH', { label }),
    remove: (id) => send<void>(`/connections/${id}`, 'DELETE'),
    selectTarget: (id, target) => post<ConnectionSummary>(`/connections/${id}/target`, { target }),
    async tools(id) {
      return (await json<{ tools: McpTool[] }>(`/connections/${id}/tools`)).tools
    },
    async webhookSecret(id, input = {}) {
      return (await post<{ secret: string }>(`/connections/${id}/webhook-secret`, input)).secret
    },
  }
}
