/**
 * Hosted MCP servers as Connect connections.
 *
 * Linear, Notion, Sentry, Stripe and others publish RFC 9728 protected-resource
 * metadata and RFC 8414 authorization-server metadata, and accept clients that
 * identify themselves by a metadata URL (MCP's Client ID Metadata Documents) or
 * register on the fly (RFC 7591). So a user can connect one with no OAuth app
 * registered by the developer at all — the zero-setup path.
 *
 * The client below speaks just enough Streamable HTTP JSON-RPC to list and call
 * tools; it runs on Workers without the SDK's Node dependencies.
 */
import type { McpTool } from '../shared/connect-types.js'
import {
  asRecord,
  basicClientAuth,
  normalizeTokens,
  ProviderError,
  ReauthorizeError,
  str,
  vendorRequest,
  type FetchLike,
  type TokenSet,
} from './http.js'

export type { McpTool }

const PROTOCOL_VERSION = '2025-06-18'
const MAX_TOOL_PAGES = 10
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Loopback hosts are reachable over plain HTTP, and only in development. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname)
}

export interface McpServerMetadata {
  /** The resource indicator tokens are bound to. */
  resource: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
  revocationEndpoint: string
  scopes: string[]
  /** The authorization server accepts a URL as client_id (CIMD). */
  clientIdMetadata: boolean
  tokenAuthMethods: string[]
}

export interface McpClient {
  clientId: string
  clientSecret: string
  /** `none`, `client_secret_post` or `client_secret_basic`. */
  authMethod: string
}

/** Rules for which URLs a user may point Connect at. */
export function assertMcpUrl(
  value: string,
  options: { allowedOrigins?: readonly string[]; development: boolean },
): URL {
  if (!URL.canParse(value)) {
    throw new ProviderError('Enter the MCP server URL, like https://mcp.example.com/mcp.')
  }
  const url = new URL(value)
  const loopback = isLoopbackHost(url.hostname)
  if (url.protocol !== 'https:' && !(options.development && loopback && url.protocol === 'http:')) {
    throw new ProviderError('MCP servers must use https.')
  }
  if (url.username || url.password) {
    throw new ProviderError('Remove credentials from the MCP server URL.')
  }
  if (!options.development && loopback) {
    throw new ProviderError('That MCP server is not reachable from production.')
  }
  if (options.allowedOrigins && !options.allowedOrigins.includes(url.origin)) {
    throw new ProviderError(`${url.origin} is not an MCP server this app allows.`)
  }
  url.hash = ''
  return url
}

function wellKnown(base: URL, suffix: string): string[] {
  const path = base.pathname.replace(/\/+$/, '')
  const urls = [`${base.origin}/.well-known/${suffix}${path}`]
  if (path) urls.push(`${base.origin}/.well-known/${suffix}`)
  return urls
}

function authServerUrls(issuer: string): string[] {
  const url = new URL(issuer)
  const path = url.pathname.replace(/\/+$/, '')
  const urls = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
  ]
  if (path) urls.push(`${url.origin}${path}/.well-known/openid-configuration`)
  return [...new Set(urls)]
}

async function tryJson(fetch: FetchLike, url: string): Promise<Record<string, unknown> | null> {
  try {
    const { body } = await vendorRequest(fetch, new URL(url).host, url, {
      headers: { accept: 'application/json' },
    })
    const record = asRecord(body)
    return Object.keys(record).length ? record : null
  } catch {
    return null
  }
}

/** `WWW-Authenticate: Bearer resource_metadata="…"` from an unauthenticated request. */
async function challengedMetadataUrl(fetch: FetchLike, server: URL): Promise<string | null> {
  try {
    const response = await fetch(server.toString(), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    })
    await response.body?.cancel()
    const header = response.headers.get('www-authenticate') ?? ''
    return /resource_metadata="([^"]+)"/i.exec(header)?.[1] ?? null
  } catch {
    return null
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(Boolean) : []
}

/** Ask the server who guards it, then ask that guard how to talk to it. */
export async function discoverMcpServer(
  fetch: FetchLike,
  server: URL,
  check: (url: string) => void,
): Promise<McpServerMetadata> {
  let resource = server.toString()
  let issuers: string[] = []
  let scopes: string[] = []
  const candidates = wellKnown(server, 'oauth-protected-resource')
  const challenged = await challengedMetadataUrl(fetch, server)
  if (challenged) candidates.unshift(challenged)
  for (const probe of candidates) {
    check(probe)
    const document = await tryJson(fetch, probe)
    const servers = stringList(document?.authorization_servers)
    if (!document || servers.length === 0) continue
    resource = str(document.resource) || resource
    issuers = servers
    scopes = stringList(document.scopes_supported)
    break
  }
  // A server without protected-resource metadata is its own authorization server.
  if (issuers.length === 0) issuers = [server.origin]

  for (const issuer of issuers) {
    check(issuer)
    for (const probe of authServerUrls(issuer)) {
      const document = await tryJson(fetch, probe)
      const authorizationEndpoint = str(document?.authorization_endpoint)
      const tokenEndpoint = str(document?.token_endpoint)
      if (!document || !authorizationEndpoint || !tokenEndpoint) continue
      for (const endpoint of [authorizationEndpoint, tokenEndpoint]) check(endpoint)
      const registrationEndpoint = str(document.registration_endpoint)
      const revocationEndpoint = str(document.revocation_endpoint)
      if (registrationEndpoint) check(registrationEndpoint)
      if (revocationEndpoint) check(revocationEndpoint)
      const methods = stringList(document.code_challenge_methods_supported)
      if (methods.length > 0 && !methods.includes('S256')) {
        throw new ProviderError(
          `${new URL(issuer).host} does not support PKCE, which MCP requires.`,
        )
      }
      return {
        resource,
        issuer: str(document.issuer) || issuer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint,
        revocationEndpoint,
        scopes: scopes.length ? scopes : stringList(document.scopes_supported),
        clientIdMetadata: document.client_id_metadata_document_supported === true,
        tokenAuthMethods: stringList(document.token_endpoint_auth_methods_supported),
      }
    }
  }
  throw new ProviderError(`${server.host} publishes no OAuth metadata Connect can use.`)
}

/** The metadata document a CIMD client_id URL serves. */
export function clientMetadataDocument(input: {
  clientId: string
  clientName: string
  redirectUri: string
  clientUri: string
}) {
  return {
    client_id: input.clientId,
    client_name: input.clientName,
    client_uri: input.clientUri,
    redirect_uris: [input.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

/** Dynamic client registration (RFC 7591), as a public client. */
export async function registerMcpClient(
  fetch: FetchLike,
  metadata: Pick<McpServerMetadata, 'issuer' | 'registrationEndpoint' | 'scopes'>,
  input: { clientName: string; redirectUri: string; clientUri: string },
): Promise<McpClient> {
  if (!metadata.registrationEndpoint) {
    throw new ProviderError(
      `${new URL(metadata.issuer).host} needs a pre-registered OAuth client. Add it under connect.custom instead.`,
    )
  }
  const { body } = await vendorRequest(
    fetch,
    `${new URL(metadata.issuer).host} client registration`,
    metadata.registrationEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: input.clientName,
        client_uri: input.clientUri,
        redirect_uris: [input.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(metadata.scopes.length ? { scope: metadata.scopes.join(' ') } : {}),
      }),
    },
  )
  const record = asRecord(body)
  const clientId = str(record.client_id)
  if (!clientId) throw new ProviderError('The authorization server registered no client_id.')
  return {
    clientId,
    clientSecret: str(record.client_secret),
    authMethod:
      str(record.token_endpoint_auth_method) ||
      (str(record.client_secret) ? 'client_secret_post' : 'none'),
  }
}

export function mcpAuthorizeUrl(
  metadata: McpServerMetadata,
  input: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const url = new URL(metadata.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', metadata.resource)
  if (metadata.scopes.length) url.searchParams.set('scope', metadata.scopes.join(' '))
  return url.toString()
}

export async function mcpTokenRequest(
  fetch: FetchLike,
  input: {
    tokenEndpoint: string
    resource: string
    client: McpClient
    params: Record<string, string>
  },
): Promise<TokenSet> {
  const params = new URLSearchParams({ ...input.params, resource: input.resource })
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  if (input.client.authMethod === 'client_secret_basic' && input.client.clientSecret) {
    headers.authorization = basicClientAuth(input.client.clientId, input.client.clientSecret)
  } else {
    params.set('client_id', input.client.clientId)
    if (input.client.clientSecret) params.set('client_secret', input.client.clientSecret)
  }
  const label = `${new URL(input.tokenEndpoint).host} token`
  const { body } = await vendorRequest(fetch, label, input.tokenEndpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
  })
  return normalizeTokens(label, asRecord(body))
}

export async function mcpRevoke(
  fetch: FetchLike,
  input: { revocationEndpoint: string; client: McpClient; token: string },
): Promise<void> {
  if (!input.revocationEndpoint) return
  const params = new URLSearchParams({ token: input.token, client_id: input.client.clientId })
  if (input.client.clientSecret) params.set('client_secret', input.client.clientSecret)
  await vendorRequest(fetch, 'MCP revocation', input.revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
}

/* ------------------------------------------------------------------ */
/* JSON-RPC over Streamable HTTP                                        */
/* ------------------------------------------------------------------ */

export interface McpCallResult {
  content: unknown[]
  structuredContent?: unknown
  isError?: boolean
}

interface RpcMessage {
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string }
}

function parseMessages(contentType: string, text: string): RpcMessage[] {
  if (!contentType.includes('text/event-stream')) {
    const parsed = JSON.parse(text) as RpcMessage | RpcMessage[]
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  const messages: RpcMessage[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    try {
      messages.push(JSON.parse(data) as RpcMessage)
    } catch {
      // Keep-alive comments and partial frames are not messages.
    }
  }
  return messages
}

/** One short-lived MCP session: initialize, then the request, then close. */
export class McpSession {
  private sessionId = ''
  private protocolVersion = PROTOCOL_VERSION
  private nextId = 1

  constructor(
    private readonly fetch: FetchLike,
    private readonly url: string,
    private readonly token: string,
    private readonly signal?: AbortSignal,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
      'mcp-protocol-version': this.protocolVersion,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    }
  }

  private async post(
    message: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<RpcMessage | null> {
    const response = await this.fetch(this.url, {
      method: 'POST',
      redirect: 'manual',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    })
    const session = response.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      throw new ReauthorizeError('The MCP server rejected the connection’s token.', response.status)
    }
    if (response.status === 202 || message.id === undefined) {
      await response.body?.cancel()
      return null
    }
    const text = await response.text()
    if (!response.ok) {
      throw new ProviderError(`The MCP server answered ${response.status}.`, response.status)
    }
    const reply = parseMessages(response.headers.get('content-type') ?? '', text).find(
      (entry) => entry.id === message.id,
    )
    if (!reply) throw new ProviderError('The MCP server sent no answer to the request.')
    if (reply.error) {
      throw new ProviderError(`MCP error: ${reply.error.message ?? reply.error.code ?? 'unknown'}`)
    }
    return reply
  }

  async open(): Promise<void> {
    const reply = await this.post({
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'cloudconfig-connect', version: '1' },
      },
    })
    const version = str(asRecord(reply?.result).protocolVersion)
    if (version) this.protocolVersion = version
    await this.post({ method: 'notifications/initialized' })
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    return (await this.post({ id: this.nextId++, method, params }, timeoutMs))?.result
  }

  async close(): Promise<void> {
    if (!this.sessionId) return
    try {
      const response = await this.fetch(this.url, {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      })
      await response.body?.cancel()
    } catch {
      // Servers may refuse explicit termination; the session expires on its own.
    }
  }
}

export async function listMcpTools(session: McpSession): Promise<McpTool[]> {
  const tools: McpTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = asRecord(await session.request('tools/list', cursor ? { cursor } : {}))
    for (const entry of Array.isArray(result.tools) ? result.tools : []) {
      const tool = asRecord(entry)
      if (!str(tool.name)) continue
      tools.push({
        name: str(tool.name),
        ...(str(tool.title) ? { title: str(tool.title) } : {}),
        ...(str(tool.description) ? { description: str(tool.description) } : {}),
        inputSchema: asRecord(tool.inputSchema),
        ...(tool.annotations
          ? { annotations: asRecord(tool.annotations) as NonNullable<McpTool['annotations']> }
          : {}),
      })
    }
    cursor = str(result.nextCursor) || undefined
    if (!cursor) break
  }
  return tools
}

export async function callMcpTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<McpCallResult> {
  const result = asRecord(await session.request('tools/call', { name, arguments: args }, timeoutMs))
  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError === true ? { isError: true } : {}),
  }
}
