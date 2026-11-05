/**
 * The slice of the h3 event this handler touches. Declared locally rather than
 * imported: Nuxt 4 ships h3 v1 and v2 side by side and their exported types
 * disagree, while these three properties exist in both.
 */
export interface H3Event {
  context: Record<string, unknown>
  /** Absent on non-Node runtimes: h3 v2 exposes it off `req.runtime`. */
  node?: { req: NodeRequestLike } | undefined
  /**
   * h3 v1's copy of the web request body, set when the event came from a
   * `Request`. This is the same field `readRawBody` prefers.
   */
  _requestBody?: BodyInit | null | undefined
}

type NodeRequestLike = AsyncIterable<Uint8Array | string> & {
  url?: string | undefined
  method?: string | undefined
  headers: Record<string, string | string[] | undefined>
  /** Set by Nitro's Cloudflare preset: the request body, already buffered. */
  body?: unknown
}

const PAYLOAD_METHODS = new Set(['PATCH', 'POST', 'PUT', 'DELETE'])
const UNSUPPORTED_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK'])

class UnsupportedRequestMethodError extends Error {
  readonly statusCode = 405

  constructor(method: string) {
    super(`The Web Request API does not support the ${method} method.`)
  }
}

/**
 * Get a Web `Request` for the event without importing an h3 helper by name:
 * Nuxt 4 ships both h3 v1 and v2, and `toWebRequest` exists only in v1. Both
 * versions expose the request object on the event, so read it from there and
 * fall back to rebuilding it from the Node request.
 *
 * The body is the part that has to be right on workerd. Nitro's Cloudflare
 * preset builds an h3 v1 event whose `node.req` is an emulated Node request:
 * iterating it hits `Readable.asyncIterator is not implemented yet!`, which
 * turned every POST — sign-up included — into a 500. That preset does hand the
 * body over already buffered on `node.req.body`, so prefer that (and h3 v1's
 * `_requestBody`) and consume the stream only on a real Node server.
 */
export async function toRequest(event: H3Event, headersOnly = false): Promise<Request> {
  const web = Reflect.get(event, 'web')
  if (typeof web === 'object' && web !== null) {
    const request = Reflect.get(web, 'request')
    if (request instanceof Request) return request
  }
  const direct = Reflect.get(event, 'request')
  if (direct instanceof Request) return direct

  // h3 v2: the event *is* built from a web Request, kept on `req`.
  const req = Reflect.get(event, 'req')
  if (req instanceof Request) return req

  const node = event.node?.req
  if (!node) {
    throw new Error(
      '[cloudconfig:nuxt] no web Request on the h3 event and no Node request to rebuild one from.',
    )
  }
  const host = node.headers.host ?? 'localhost'
  const proto = node.headers['x-forwarded-proto'] ?? 'http'
  const url = new URL(node.url ?? '/', `${String(proto).split(',')[0]}://${host}`)
  const method = node.method ?? 'GET'
  if (UNSUPPORTED_METHODS.has(method)) throw new UnsupportedRequestMethodError(method)
  const headers = new Headers()
  for (const [key, value] of Object.entries(node.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item)
  }
  // Match h3's payload boundary: Cloudflare cannot iterate its emulated Node
  // stream for methods such as OPTIONS, which do not have a buffered payload.
  if (headersOnly || !PAYLOAD_METHODS.has(method)) return new Request(url, { method, headers })

  // Anything that already holds the whole body, in order of how directly it
  // gives it to us. Nitro's Cloudflare preset fills `node.req.body` with a
  // Buffer, and h3 keeps `_requestBody` when the event came from a `Request`;
  // either one avoids iterating the stream below.
  const buffered = event._requestBody ?? (node.body as BodyInit | undefined)
  if (buffered !== undefined && buffered !== null) {
    return new Request(url, {
      method,
      headers,
      body: buffered,
      // Required whenever the body is a stream rather than a buffer.
      ...({ duplex: 'half' } as { duplex: 'half' }),
    })
  }

  // Nitro does not buffer DELETE, including ordinary CRUD requests with no
  // payload. Without HTTP body framing there is no Node stream to consume.
  if (!headers.has('transfer-encoding') && Number(headers.get('content-length') ?? 0) <= 0) {
    return new Request(url, { method, headers })
  }

  const chunks: Uint8Array[] = []
  for await (const chunk of node) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
  }
  return new Request(url, { method, headers, body: Buffer.concat(chunks) })
}
