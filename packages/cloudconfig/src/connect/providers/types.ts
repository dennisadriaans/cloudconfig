/**
 * The server-side contract every Connect provider implements. A provider owns
 * its vendor's quirks — URLs, token shapes, account naming, webhook envelopes —
 * and nothing else: persistence, sealing, policy and refresh coordination live
 * in the runtime, so a new provider never grows a new storage path.
 */
import type { ConnectionScope } from '../../dsl/connect-config.js'
import type { FetchLike, TokenSet } from '../http.js'
import type { ConnectTarget } from '../../shared/connect-types.js'

export type { ConnectTarget }

export interface ProviderCredentials {
  clientId: string
  clientSecret: string
  /** Extra secrets by key (`appId`, `privateKey`, `signingSecret`, …). */
  extra: Readonly<Record<string, string>>
  options: Readonly<Record<string, string | number | boolean>>
}

export interface ConnectedAccount {
  /** Stable vendor id: user, workspace, site or installation. */
  id: string
  name: string
  url?: string
}

export interface AuthorizeInput {
  credentials: ProviderCredentials
  redirectUri: string
  state: string
  scopes: readonly string[]
  challenge?: string
  scope: ConnectionScope
  fields: Readonly<Record<string, string>>
}

export interface ExchangeInput {
  credentials: ProviderCredentials
  code: string
  redirectUri: string
  verifier?: string
  query: URLSearchParams
  fields: Readonly<Record<string, string>>
  scope: ConnectionScope
  fetch: FetchLike
}

export interface IdentifyResult {
  account: ConnectedAccount
  metadata?: Record<string, unknown>
  /** More than one: the user picks before the connection becomes active. */
  targets?: ConnectTarget[]
}

export interface TokenContext {
  credentials: ProviderCredentials
  tokens: TokenSet
  metadata: Readonly<Record<string, unknown>>
  scope: ConnectionScope
  fetch: FetchLike
}

export interface WebhookInput {
  request: Request
  rawBody: string
  payload: unknown
  headers: Headers
  credentials: ProviderCredentials
}

export interface WebhookSupport {
  verify(input: WebhookInput): Promise<boolean>
  /** The vendor account a delivery belongs to — matched against `connection.accountId`. */
  accountId(input: { payload: unknown; headers: Headers }): string
  describe(input: { payload: unknown; headers: Headers }): { event: string; deliveryId: string }
  /** Answer a vendor handshake (Slack URL verification) instead of dispatching. */
  handshake?(input: { payload: unknown; headers: Headers }): Response | null
}

export interface ProviderRuntime {
  id: string
  label: string
  pkce: boolean
  /** Scopes added to every request, because identifying the account needs them. */
  baseScopes?: readonly string[]
  /** Extra secret keys without which the provider reports itself unconfigured. */
  requiredExtra?: readonly string[]
  authorizeUrl(input: AuthorizeInput): string
  /** Reject a callback before using it (Shopify signs the query). */
  verifyCallback?(input: {
    query: URLSearchParams
    credentials: ProviderCredentials
    fields: Readonly<Record<string, string>>
  }): Promise<string | null>
  /** Send the browser somewhere else first (GitHub's install screen). */
  continueAuthorization?(
    input: TokenContext & { query: URLSearchParams; state: string },
  ): Promise<string | null>
  exchange(input: ExchangeInput): Promise<TokenSet>
  identify(
    input: TokenContext & { query: URLSearchParams; fields: Readonly<Record<string, string>> },
  ): Promise<IdentifyResult>
  /** Point a pending workspace connection at the target the user picked. */
  selectTarget?(
    input: TokenContext & { target: ConnectTarget },
  ): Promise<{ account: ConnectedAccount; metadata: Record<string, unknown> }>
  refresh?(input: TokenContext): Promise<TokenSet>
  /**
   * The token server code uses, when it is not the stored OAuth token: a
   * GitHub installation token, a Discord bot token. `null` uses the stored one.
   */
  mint?(input: TokenContext): Promise<TokenSet | null>
  revoke?(input: TokenContext): Promise<void>
  webhook?: WebhookSupport
}
