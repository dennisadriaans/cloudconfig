/**
 * The transport the session-scoped clients (account, admin, organizations,
 * Connect, SCIM) share: the session cookie, JSON in and out, and the server's
 * error message surfaced as a `CloudConfigClientError`.
 */
import { CloudConfigClientError, type ClientOptions } from './index.js'

export interface SessionRequest {
  /** Fetch `path` under the client's base URL; throws on a non-2xx answer. */
  request(path: string, init?: RequestInit): Promise<Response>
  /** `request`, parsed as JSON; an empty body (204) resolves to `undefined`. */
  json<T>(path: string, init?: RequestInit): Promise<T>
  /** POST `body` as JSON and parse the answer. */
  post<T>(path: string, body?: unknown): Promise<T>
}

export function sessionRequest(options: ClientOptions, defaultBaseUrl: string): SessionRequest {
  const base = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, '')
  const fetcher = options.fetch ?? fetch

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(
      typeof options.headers === 'function' ? options.headers() : options.headers,
    )
    if (init?.body) headers.set('content-type', 'application/json')
    const response = await fetcher(`${base}${path}`, { credentials: 'include', ...init, headers })
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      const message =
        body && typeof body === 'object' && 'message' in body
          ? String(body.message)
          : `Request failed (${response.status})`
      throw new CloudConfigClientError(message, response.status, body)
    }
    return response
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const text = await (await request(path, init)).text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  function post<T>(path: string, body: unknown = {}): Promise<T> {
    return json<T>(path, { method: 'POST', body: JSON.stringify(body) })
  }

  return { request, json, post }
}
