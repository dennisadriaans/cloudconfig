/**
 * Vendor HTTP for Connect: bounded time, bounded size, and errors that name
 * the vendor and status without echoing a token back into a log.
 */
import { base64Encode } from './crypto.js'

const TIMEOUT_MS = 15_000
const MAX_BYTES = 1_000_000

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    /** OAuth error code (`invalid_grant`, …) when the vendor sent one. */
    readonly code = '',
  ) {
    super(message)
  }
}

/** Thrown when the user must authorize again: the grant is gone or revoked. */
export class ReauthorizeError extends ProviderError {}

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** Epoch ms; absent when the vendor issues non-expiring tokens. */
  expiresAt?: number
  refreshExpiresAt?: number
  scope?: string
  /** `Bearer` unless the vendor says otherwise (`Bot` for Discord). */
  tokenType?: string
  /** Non-token fields of the token response (Slack team, Notion workspace, …). */
  raw?: Record<string, unknown>
}

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new ProviderError('The vendor answered with more data than Connect accepts.')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(bytes)
}

export async function vendorRequest(
  fetcher: FetchLike,
  label: string,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  let response: Response
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (cause) {
    throw new ProviderError(
      `${label} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const text = await readBody(response)
  let body: unknown = text
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = Object.fromEntries(new URLSearchParams(text))
    }
  }
  if (!response.ok) {
    const record = asRecord(body)
    const code = str(record.error) || str(asRecord(record.error).code)
    const description =
      str(record.error_description) || str(record.message) || str(asRecord(record.error).message)
    const detail = [code, description].filter(Boolean).join(': ').slice(0, 300)
    const message = `${label} answered ${response.status}${detail ? ` (${detail})` : ''}.`
    if (code === 'invalid_grant' || code === 'invalid_token' || response.status === 401) {
      throw new ReauthorizeError(message, response.status, code)
    }
    throw new ProviderError(message, response.status, code)
  }
  return { status: response.status, body, headers: response.headers }
}

export async function getJson(
  fetcher: FetchLike,
  label: string,
  url: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const { body } = await vendorRequest(fetcher, label, url, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...headers },
  })
  return asRecord(body)
}

/** RFC 6749 §2.3.1 client authentication: form-encode each part, then base64. */
export function basicClientAuth(clientId: string, clientSecret: string): string {
  const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  return `Basic ${base64Encode(new TextEncoder().encode(credentials))}`
}

export interface TokenRequest {
  url: string
  params: Record<string, string>
  clientId: string
  clientSecret: string
  /** How the endpoint wants client credentials. */
  auth: 'body' | 'basic' | 'none'
  /** Send JSON instead of a form (Atlassian, Notion, Shopify). */
  json?: boolean
}

/** POST to a token endpoint and normalize the answer. */
export async function tokenRequest(
  fetcher: FetchLike,
  label: string,
  request: TokenRequest,
): Promise<TokenSet> {
  const params: Record<string, string> = { ...request.params }
  const headers: Record<string, string> = { accept: 'application/json' }
  if (request.auth === 'body') {
    params.client_id = request.clientId
    params.client_secret = request.clientSecret
  } else if (request.auth === 'basic') {
    headers.authorization = basicClientAuth(request.clientId, request.clientSecret)
  } else {
    params.client_id = request.clientId
  }
  headers['content-type'] = request.json ? 'application/json' : 'application/x-www-form-urlencoded'
  const { body } = await vendorRequest(fetcher, label, request.url, {
    method: 'POST',
    headers,
    body: request.json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
  })
  return normalizeTokens(label, asRecord(body))
}

const TOKEN_FIELDS = new Set([
  'access_token',
  'refresh_token',
  'expires_in',
  'refresh_token_expires_in',
  'scope',
  'token_type',
  'id_token',
])

export function normalizeTokens(label: string, body: Record<string, unknown>): TokenSet {
  // Slack and others answer 200 with `ok: false` and an error code.
  if (body.ok === false || (str(body.error) && !str(body.access_token))) {
    const code = str(body.error)
    const message = `${label} refused the request${code ? ` (${code})` : ''}.`
    if (code === 'invalid_grant' || code === 'invalid_refresh_token' || code === 'token_revoked') {
      throw new ReauthorizeError(message, 400, code)
    }
    throw new ProviderError(message, 400, code)
  }
  const accessToken = str(body.access_token)
  if (!accessToken) throw new ProviderError(`${label} returned no access token.`)
  const now = Date.now()
  const expiresIn = Number(body.expires_in)
  const refreshExpiresIn = Number(body.refresh_token_expires_in)
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) if (!TOKEN_FIELDS.has(key)) raw[key] = value
  return {
    accessToken,
    ...(str(body.refresh_token) ? { refreshToken: str(body.refresh_token) } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
      ? { refreshExpiresAt: now + refreshExpiresIn * 1000 }
      : {}),
    ...(str(body.scope) ? { scope: str(body.scope) } : {}),
    ...(str(body.token_type) ? { tokenType: str(body.token_type) } : {}),
    raw,
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function str(value: unknown): string {
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' ? value : ''
}
