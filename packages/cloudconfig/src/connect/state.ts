/**
 * The OAuth round-trip state: sealed, short-lived, and bound to the browser
 * session that started the flow.
 *
 * It carries no user id. The account is re-derived from the session on the
 * callback and compared with a keyed hash taken at the start; without that
 * check an attacker could start a flow in their own browser and feed the code
 * into a victim's session (the classic code-injection CSRF). It is sealed, not
 * just signed, because it carries the PKCE verifier.
 */
import type { ConnectionScope } from '../dsl/connect-config.js'
import { keyringHmac, reveal, seal, timingSafeEqual, type Keyring } from './crypto.js'

const STATE_TTL_MS = 15 * 60 * 1000
const STATE_AAD = 'cloudconfig.connect.v1:state'

export interface FlowState {
  provider: string
  scope: ConnectionScope
  organizationId: number | null
  /** Keyed hash of the session user. Compared, never looked up. */
  subject: string
  returnTo: string
  redirectUri: string
  scopes: readonly string[]
  verifier?: string
  /** Values entered before authorizing (Shopify store). */
  fields?: Record<string, string>
  /** Uid of a connection this flow re-authorizes or finishes. */
  connection?: string
  label?: string
  mcp?: {
    server: string
    /** `cimd`, or the uid of a dynamically registered client. */
    client: string
    resource: string
    issuer: string
    tokenEndpoint: string
    revocationEndpoint: string
  }
  issuedAt: number
}

export async function subjectOf(keyring: Keyring, userId: number): Promise<string> {
  return (await keyringHmac(keyring, 'oauth-subject', String(userId))).slice(0, 32)
}

export async function encodeState(
  keyring: Keyring,
  state: Omit<FlowState, 'issuedAt' | 'subject'> & { userId: number },
): Promise<string> {
  const { userId, ...rest } = state
  const payload: FlowState = {
    ...rest,
    subject: await subjectOf(keyring, userId),
    issuedAt: Date.now(),
  }
  return seal(keyring, JSON.stringify(payload), STATE_AAD)
}

/** The state, if it is ours, fresh, for this provider and for this signed-in user. */
export async function decodeState(
  keyring: Keyring,
  raw: string,
  expect: { provider: string; userId: number },
): Promise<FlowState | null> {
  let payload: FlowState
  try {
    payload = JSON.parse((await reveal(keyring, raw, STATE_AAD)).value) as FlowState
  } catch {
    return null
  }
  if (typeof payload.issuedAt !== 'number' || Date.now() - payload.issuedAt > STATE_TTL_MS) {
    return null
  }
  if (payload.provider !== expect.provider) return null
  if (!timingSafeEqual(payload.subject, await subjectOf(keyring, expect.userId))) return null
  return payload
}

/**
 * A same-origin path to return to. Anything else (another host, `//evil`,
 * `javascript:`) collapses to `/`, so the callback can never be an open redirect.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  if (value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '/'
  return value.slice(0, 2000)
}
