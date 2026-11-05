/**
 * Webhook signature checks. Every vendor picked its own envelope; the parts
 * that differ are the header, the encoding, whether a timestamp is signed, and
 * whether the value is an HMAC at all. All comparisons are constant-time.
 */
import {
  base64Encode,
  base64UrlDecode,
  bytesToHex,
  hexToBytes,
  hmacSha1,
  hmacSha256,
  timingSafeEqual,
  toBuffer,
} from './crypto.js'

/** Deliveries older than this are refused where the vendor signs a timestamp. */
const MAX_AGE_SECONDS = 5 * 60

function fresh(seconds: number, now = Date.now()): boolean {
  return Number.isFinite(seconds) && Math.abs(now / 1000 - seconds) <= MAX_AGE_SECONDS
}

function hexEquals(expected: Uint8Array, presented: string): boolean {
  const value = presented.trim().toLowerCase()
  return /^[0-9a-f]+$/.test(value) && timingSafeEqual(bytesToHex(expected), value)
}

/** `X-Hub-Signature-256: sha256=<hex>` — GitHub, Bitbucket. */
export async function verifyHubSignature(rawBody: string, secret: string, header: string | null) {
  if (!secret || !header) return false
  return hexEquals(await hmacSha256(secret, rawBody), header.replace(/^sha256=/i, ''))
}

/** `Linear-Signature: <hex>` — bare HMAC-SHA256, plus a signed `webhookTimestamp` in the body. */
export async function verifyLinearSignature(
  rawBody: string,
  secret: string,
  header: string | null,
  payload?: unknown,
) {
  if (!secret || !header) return false
  if (!hexEquals(await hmacSha256(secret, rawBody), header)) return false
  const timestamp = (payload as { webhookTimestamp?: unknown } | undefined)?.webhookTimestamp
  return typeof timestamp !== 'number' || fresh(timestamp / 1000)
}

/** Slack: `v0=` HMAC of `v0:<timestamp>:<body>` with the app signing secret. */
export async function verifySlackSignature(rawBody: string, secret: string, headers: Headers) {
  const signature = headers.get('x-slack-signature')
  const timestamp = headers.get('x-slack-request-timestamp')
  if (!secret || !signature || !timestamp || !fresh(Number(timestamp))) return false
  return hexEquals(
    await hmacSha256(secret, `v0:${timestamp}:${rawBody}`),
    signature.replace(/^v0=/, ''),
  )
}

/** `X-Shopify-Hmac-Sha256: <base64>` with the app client secret. */
export async function verifyShopifySignature(
  rawBody: string,
  secret: string,
  header: string | null,
) {
  if (!secret || !header) return false
  return timingSafeEqual(base64Encode(await hmacSha256(secret, rawBody)), header.trim())
}

/**
 * Shopify signs the OAuth callback query too: every parameter except `hmac`,
 * sorted, joined as a query string, HMAC-SHA256 hex with the client secret.
 */
export async function verifyShopifyQuery(query: URLSearchParams, secret: string) {
  const presented = query.get('hmac')
  if (!secret || !presented) return false
  const message = [...query.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    // Byte order, as Shopify computes it; parameter names are unique.
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  return hexEquals(await hmacSha256(secret, message), presented)
}

/** HubSpot v3: base64 HMAC of method + URI + body + timestamp with the client secret. */
export async function verifyHubSpotSignature(
  request: { method: string; url: string },
  rawBody: string,
  secret: string,
  headers: Headers,
) {
  const signature = headers.get('x-hubspot-signature-v3')
  const timestamp = headers.get('x-hubspot-request-timestamp')
  if (!secret || !signature || !timestamp || !fresh(Number(timestamp) / 1000)) return false
  let uri: string
  try {
    uri = decodeURI(request.url)
  } catch {
    return false
  }
  const expected = base64Encode(
    await hmacSha256(secret, `${request.method}${uri}${rawBody}${timestamp}`),
  )
  return timingSafeEqual(expected, signature.trim())
}

/** Intercom: `X-Hub-Signature: sha1=<hex>` with the client secret. */
export async function verifyIntercomSignature(
  rawBody: string,
  secret: string,
  header: string | null,
) {
  if (!secret || !header) return false
  return hexEquals(await hmacSha1(secret, rawBody), header.replace(/^sha1=/i, ''))
}

/** Notion: `X-Notion-Signature: sha256=<hex>` with the subscription's verification token. */
export async function verifyNotionSignature(
  rawBody: string,
  secret: string,
  header: string | null,
) {
  return verifyHubSignature(rawBody, secret, header)
}

/** GitLab echoes the hook's secret token instead of signing the body. */
export function verifySharedToken(secret: string, header: string | null) {
  return Boolean(secret && header) && timingSafeEqual(secret, header!.trim())
}

/** Stripe: `Stripe-Signature: t=<ts>,v1=<hex>` over `<ts>.<body>` with the endpoint secret. */
export async function verifyStripeSignature(
  rawBody: string,
  secret: string,
  header: string | null,
) {
  if (!secret || !header) return false
  const parts = new Map<string, string[]>()
  for (const part of header.split(',')) {
    const [key, value] = part.split('=')
    if (!key || !value) continue
    parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()])
  }
  const timestamp = parts.get('t')?.[0]
  if (!timestamp || !fresh(Number(timestamp))) return false
  const expected = await hmacSha256(secret, `${timestamp}.${rawBody}`)
  return (parts.get('v1') ?? []).some((value) => hexEquals(expected, value))
}

/**
 * Atlassian OAuth 2.0 (3LO) dynamic webhooks: `Authorization: Bearer <jwt>`
 * signed HS256 with the app's client secret. Not an `X-Hub-Signature` body.
 */
export async function verifyAtlassianJwt(secret: string, authorization: string | null) {
  if (!secret || !authorization) return false
  const token = authorization.replace(/^(Bearer|JWT)\s+/i, '').trim()
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) return false
  try {
    const head = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as { alg?: string }
    if (head.alg !== 'HS256') return false
    const expected = await hmacSha256(secret, `${header}.${payload}`)
    if (!timingSafeEqual(expected, base64UrlDecode(signature))) return false
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
      exp?: number
      nbf?: number
    }
    const now = Date.now() / 1000
    if (typeof claims.exp === 'number' && claims.exp + 60 < now) return false
    return !(typeof claims.nbf === 'number' && claims.nbf - 60 > now)
  } catch {
    return false
  }
}

/** Discord interactions: Ed25519 over `<timestamp><body>` with the app's public key. */
export async function verifyDiscordSignature(rawBody: string, publicKey: string, headers: Headers) {
  const signature = headers.get('x-signature-ed25519')
  const timestamp = headers.get('x-signature-timestamp')
  if (!publicKey || !signature || !timestamp || !fresh(Number(timestamp))) return false
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      toBuffer(hexToBytes(publicKey.trim())),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      toBuffer(hexToBytes(signature.trim())),
      toBuffer(new TextEncoder().encode(`${timestamp}${rawBody}`)),
    )
  } catch {
    return false
  }
}

/**
 * Connect's own envelope for app-defined event senders: `X-CloudConfig-Signature:
 * t=<seconds>,v1=<hex>` over `<seconds>.<body>` with the connection's webhook secret.
 */
export async function verifyConnectSignature(
  rawBody: string,
  secret: string,
  header: string | null,
) {
  return verifyStripeSignature(rawBody, secret, header)
}

/** Produce Connect's envelope, for senders and tests. */
export async function signConnectPayload(rawBody: string, secret: string, now = Date.now()) {
  const timestamp = Math.floor(now / 1000)
  return `t=${timestamp},v1=${bytesToHex(await hmacSha256(secret, `${timestamp}.${rawBody}`))}`
}
