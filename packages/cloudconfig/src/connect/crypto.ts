/**
 * Sealing for Connect secrets, on WebCrypto so it runs unchanged on Workers
 * and Node.
 *
 * A database dump must not contain a value anyone can present to a vendor.
 * Every token, API key and webhook secret is AES-256-GCM sealed under a key
 * held in the environment, never in the database. The ciphertext names the key
 * that sealed it (so keys can rotate) and is bound to its row and column
 * through the additional data, so a blob copied onto another row fails to open.
 *
 *   enc.v1.<keyId>.<base64url(iv ‖ ciphertext)>
 */

const PREFIX = 'enc.v1.'
const HEX_KEY = /^[0-9a-f]{64}$/i
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Used only in development without a configured key, so the first connect works. */
const DEVELOPMENT_KEY = 'cloudconfig-connect-development-key-not-for-production'

export interface Keyring {
  /** Seals new values. */
  primary: string
  /** Key id → 32 raw bytes. Every key can open what it sealed. */
  keys: ReadonlyMap<string, Uint8Array>
  /** True when running on the development fallback. */
  development: boolean
}

export class KeyringError extends Error {}

/**
 * Parse `hex` or `id:hex,id:hex` (first entry seals). Development without a
 * value derives a fixed key so `pnpm dev` works before any setup; anywhere
 * else a missing or malformed key is a hard error.
 */
export async function parseKeyring(
  value: string | undefined,
  options: { development: boolean; envName: string },
): Promise<Keyring> {
  const raw = value?.trim()
  if (!raw) {
    if (!options.development) {
      throw new KeyringError(
        `${options.envName} is not set. Connections cannot be sealed without it. Run: cloudconfig connect key`,
      )
    }
    const bytes = new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(DEVELOPMENT_KEY)),
    )
    return { primary: 'dev', keys: new Map([['dev', bytes]]), development: true }
  }
  const keys = new Map<string, Uint8Array>()
  let primary = ''
  for (const [index, entry] of raw.split(',').entries()) {
    const part = entry.trim()
    const separator = part.indexOf(':')
    const id = separator === -1 ? `k${index + 1}` : part.slice(0, separator)
    const hex = separator === -1 ? part : part.slice(separator + 1)
    if (!KEY_ID.test(id) || !HEX_KEY.test(hex)) {
      throw new KeyringError(
        `${options.envName} must be 64 hex characters, or a list like "k2:<hex>,k1:<hex>". Generate one with: cloudconfig connect key`,
      )
    }
    if (keys.has(id)) throw new KeyringError(`${options.envName} lists key "${id}" twice.`)
    keys.set(id, hexToBytes(hex))
    if (!primary) primary = id
  }
  return { primary, keys, development: false }
}

const derived = new WeakMap<Uint8Array, Map<string, Promise<CryptoKey>>>()

/** HKDF per purpose, so the sealing key is never also an HMAC key. */
function deriveKey(raw: Uint8Array, purpose: string, usage: 'aes' | 'hmac'): Promise<CryptoKey> {
  let byPurpose = derived.get(raw)
  if (!byPurpose) {
    byPurpose = new Map()
    derived.set(raw, byPurpose)
  }
  const cacheKey = `${usage}:${purpose}`
  const cached = byPurpose.get(cacheKey)
  if (cached) return cached
  const created = (async () => {
    const base = await crypto.subtle.importKey('raw', toBuffer(raw), 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toBuffer(encoder.encode('cloudconfig.connect')),
        info: toBuffer(encoder.encode(purpose)),
      },
      base,
      usage === 'aes'
        ? { name: 'AES-GCM', length: 256 }
        : { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      usage === 'aes' ? ['encrypt', 'decrypt'] : ['sign', 'verify'],
    )
  })()
  byPurpose.set(cacheKey, created)
  return created
}

/** Additional data binding a sealed value to one column of one row. */
export function aad(table: string, field: string, uid: string): string {
  return `cloudconfig.connect.v1:${table}.${field}:${uid}`
}

export function isSealed(value: string): boolean {
  return value.startsWith(PREFIX)
}

/** What every value sealed under `keyId` starts with; anything else needs re-sealing. */
export function sealPrefix(keyId: string): string {
  return `${PREFIX}${keyId}.`
}

/** AES-GCM seal. Empty stays empty, so "not set" never becomes a blob. */
export async function seal(
  keyring: Keyring,
  plaintext: string,
  additional: string,
): Promise<string> {
  if (!plaintext) return ''
  const raw = keyring.keys.get(keyring.primary)!
  const key = await deriveKey(raw, 'seal', 'aes')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: toBuffer(encoder.encode(additional)) },
      key,
      toBuffer(encoder.encode(plaintext)),
    ),
  )
  const packed = new Uint8Array(iv.length + cipher.length)
  packed.set(iv, 0)
  packed.set(cipher, iv.length)
  return `${sealPrefix(keyring.primary)}${base64UrlEncode(packed)}`
}

export interface Revealed {
  value: string
  /** Sealed by a key other than the primary: write it back to rotate. */
  stale: boolean
}

export async function reveal(
  keyring: Keyring,
  stored: string,
  additional: string,
): Promise<Revealed> {
  if (!stored) return { value: '', stale: false }
  if (!isSealed(stored)) {
    throw new KeyringError('A stored secret is not sealed. Reconnect the account.')
  }
  const body = stored.slice(PREFIX.length)
  const dot = body.indexOf('.')
  if (dot === -1) throw new KeyringError('A stored secret is malformed.')
  const id = body.slice(0, dot)
  const raw = keyring.keys.get(id)
  if (!raw) {
    throw new KeyringError(
      `This secret was sealed with key "${id}", which is not in the keyring. Restore it or reconnect the account.`,
    )
  }
  const packed = base64UrlDecode(body.slice(dot + 1))
  if (packed.length < 13) throw new KeyringError('A stored secret is truncated.')
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toBuffer(packed.slice(0, 12)),
        additionalData: toBuffer(encoder.encode(additional)),
      },
      await deriveKey(raw, 'seal', 'aes'),
      toBuffer(packed.slice(12)),
    )
    return { value: decoder.decode(plain), stale: id !== keyring.primary }
  } catch {
    throw new KeyringError('A stored secret could not be opened. It was moved or the key changed.')
  }
}

/** Seal a JSON value. */
export async function sealJson(
  keyring: Keyring,
  value: unknown,
  additional: string,
): Promise<string> {
  return seal(keyring, JSON.stringify(value), additional)
}

export async function revealJson<T>(
  keyring: Keyring,
  stored: string,
  additional: string,
): Promise<{ value: T | undefined; stale: boolean }> {
  const revealed = await reveal(keyring, stored, additional)
  return {
    value: revealed.value ? (JSON.parse(revealed.value) as T) : undefined,
    stale: revealed.stale,
  }
}

/** HMAC under a keyring-derived key, for values Connect signs itself (OAuth state). */
export async function keyringHmac(
  keyring: Keyring,
  purpose: string,
  data: string,
): Promise<string> {
  const key = await deriveKey(keyring.keys.get(keyring.primary)!, purpose, 'hmac')
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, toBuffer(encoder.encode(data)))),
  )
}

/** Verify against every key, so a rotation does not break flows already in flight. */
export async function keyringVerify(
  keyring: Keyring,
  purpose: string,
  data: string,
  signature: string,
): Promise<boolean> {
  const presented = base64UrlDecode(signature)
  for (const raw of keyring.keys.values()) {
    const key = await deriveKey(raw, purpose, 'hmac')
    if (
      await crypto.subtle.verify('HMAC', key, toBuffer(presented), toBuffer(encoder.encode(data)))
    ) {
      return true
    }
  }
  return false
}

async function hmac(
  hash: 'SHA-1' | 'SHA-256',
  secret: string | Uint8Array,
  data: string | Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toBuffer(typeof secret === 'string' ? encoder.encode(secret) : secret),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  )
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      toBuffer(typeof data === 'string' ? encoder.encode(data) : data),
    ),
  )
}

export function hmacSha256(
  secret: string | Uint8Array,
  data: string | Uint8Array,
): Promise<Uint8Array> {
  return hmac('SHA-256', secret, data)
}

/** Only for vendors that still sign with SHA-1 (Intercom). */
export function hmacSha1(secret: string, data: string | Uint8Array): Promise<Uint8Array> {
  return hmac('SHA-1', secret, data)
}

export async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toBuffer(encoder.encode(data))))
}

/** Constant-time comparison; length is not secret. */
export function timingSafeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const left = typeof a === 'string' ? encoder.encode(a) : a
  const right = typeof b === 'string' ? encoder.encode(b) : b
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}

/** PKCE S256 pair. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: base64UrlEncode(await sha256(verifier)) }
}

/** URL-safe random id with an optional prefix, e.g. `con_…`. */
export function randomId(prefix = ''): string {
  const id = base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)))
  return prefix ? `${prefix}_${id}` : id
}

export function randomHex(bytes = 32): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('Expected a hex string.')
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index)
  return out
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return base64Decode(normalized + padding)
}

/** WebCrypto wants an ArrayBuffer-backed view; copy when a view shares a larger buffer. */
export function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes)
}
