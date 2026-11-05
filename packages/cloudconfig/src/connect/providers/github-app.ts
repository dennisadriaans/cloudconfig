/**
 * Acting as a GitHub App installation: an RS256 app JWT, exchanged for a
 * one-hour installation token scoped to the repositories the installer chose.
 * The token belongs to the installation, not a person, so a workspace
 * connection keeps working after whoever installed it leaves.
 */
import { asRecord, str, vendorRequest, type FetchLike, type TokenSet } from '../http.js'
import { base64Decode, base64UrlEncode, toBuffer } from '../crypto.js'

const RSA_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]

function derLength(length: number): number[] {
  if (length < 0x80) return [length]
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

/** GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`); WebCrypto imports PKCS#8. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const body = [
    0x02,
    0x01,
    0x00,
    ...RSA_ALGORITHM_IDENTIFIER,
    0x04,
    ...derLength(pkcs1.length),
    ...pkcs1,
  ]
  return Uint8Array.from([0x30, ...derLength(body.length), ...body])
}

const keys = new Map<string, Promise<CryptoKey>>()

function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cached = keys.get(pem)
  if (cached) return cached
  const normalized = pem.replace(/\\n/g, '\n').trim()
  const isPkcs1 = normalized.includes('BEGIN RSA PRIVATE KEY')
  const der = base64Decode(normalized.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''))
  const created = crypto.subtle.importKey(
    'pkcs8',
    toBuffer(isPkcs1 ? pkcs1ToPkcs8(der) : der),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  created.catch(() => keys.delete(pem))
  keys.set(pem, created)
  return created
}

/** A ten-minute app JWT. `iss` accepts the App ID or the client id. */
export async function githubAppJwt(issuer: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: issuer,
  })}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await importPrivateKey(privateKey),
    toBuffer(new TextEncoder().encode(unsigned)),
  )
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`
}

export const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'cloudconfig-connect',
  'x-github-api-version': '2022-11-28',
} as const

export async function githubInstallationToken(
  fetch: FetchLike,
  input: { issuer: string; privateKey: string; installationId: string },
): Promise<TokenSet> {
  if (!/^\d+$/.test(input.installationId)) {
    throw new Error('This GitHub connection has no installation.')
  }
  const jwt = await githubAppJwt(input.issuer, input.privateKey)
  const { body } = await vendorRequest(
    fetch,
    'GitHub installation token',
    `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
    { method: 'POST', headers: { ...GITHUB_HEADERS, authorization: `Bearer ${jwt}` } },
  )
  const record = asRecord(body)
  const token = str(record.token)
  if (!token) throw new Error('GitHub returned no installation token.')
  const expiresAt = Date.parse(str(record.expires_at))
  return {
    accessToken: token,
    tokenType: 'Bearer',
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
  }
}
