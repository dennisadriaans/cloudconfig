/**
 * A standard OAuth 2.0 authorization-code provider. Most vendors are this
 * plus one or two overrides, so the built-in providers and every
 * `connect.custom` entry are built from it.
 */
import { getJson, str, tokenRequest, vendorRequest, type FetchLike } from '../http.js'
import type { ConnectedAccount, ProviderCredentials, ProviderRuntime } from './types.js'

type CredentialUrl = string | ((credentials: ProviderCredentials) => string)

export interface OAuth2Definition {
  id: string
  label: string
  authorizeUrl: CredentialUrl
  tokenUrl: CredentialUrl
  revokeUrl?: CredentialUrl
  /** Scopes added to every request, because identifying the account needs them. */
  baseScopes?: readonly string[]
  scopeSeparator?: string
  tokenAuth?: 'body' | 'basic'
  tokenJson?: boolean
  pkce?: boolean
  authorizeParams?: Record<string, string>
  /** Revocation sends the token as a form field (`body`) or as a bearer (`bearer`). */
  revokeStyle?: 'body' | 'bearer'
  /** Answer the account from a userinfo endpoint. */
  userInfo?: {
    url: CredentialUrl
    headers?: Record<string, string>
    map(body: Record<string, unknown>): ConnectedAccount
  }
}

function resolve(value: CredentialUrl, credentials: ProviderCredentials): string {
  return typeof value === 'function' ? value(credentials) : value
}

export function oauth2(definition: OAuth2Definition): ProviderRuntime {
  const separator = definition.scopeSeparator ?? ' '

  function requestTokens(
    fetch: FetchLike,
    credentials: ProviderCredentials,
    purpose: string,
    params: Record<string, string>,
  ) {
    return tokenRequest(fetch, `${definition.label} ${purpose}`, {
      url: resolve(definition.tokenUrl, credentials),
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      auth: definition.tokenAuth ?? 'body',
      ...(definition.tokenJson ? { json: true } : {}),
      params,
    })
  }

  return {
    id: definition.id,
    label: definition.label,
    pkce: definition.pkce ?? true,
    ...(definition.baseScopes ? { baseScopes: definition.baseScopes } : {}),

    authorizeUrl({ credentials, redirectUri, state, scopes, challenge }) {
      const url = new URL(resolve(definition.authorizeUrl, credentials))
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', credentials.clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      if (scopes.length > 0) url.searchParams.set('scope', scopes.join(separator))
      if (challenge) {
        url.searchParams.set('code_challenge', challenge)
        url.searchParams.set('code_challenge_method', 'S256')
      }
      for (const [key, value] of Object.entries(definition.authorizeParams ?? {})) {
        url.searchParams.set(key, value)
      }
      return url.toString()
    },

    exchange({ credentials, code, redirectUri, verifier, fetch }) {
      return requestTokens(fetch, credentials, 'token exchange', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        ...(verifier ? { code_verifier: verifier } : {}),
      })
    },

    async refresh({ credentials, tokens, fetch }) {
      if (!tokens.refreshToken) throw new Error(`${definition.label} issued no refresh token.`)
      const next = await requestTokens(fetch, credentials, 'token refresh', {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      })
      // A refresh grant may legally omit a new refresh token; keep the old one.
      return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken }
    },

    async identify({ credentials, tokens, fetch }) {
      if (!definition.userInfo) return { account: { id: '', name: definition.label } }
      const body = await getJson(
        fetch,
        `${definition.label} account`,
        resolve(definition.userInfo.url, credentials),
        tokens.accessToken,
        definition.userInfo.headers,
      )
      return { account: definition.userInfo.map(body) }
    },

    ...(definition.revokeUrl
      ? {
          async revoke({ credentials, tokens, fetch }) {
            await revokeToken(
              fetch,
              definition,
              credentials,
              tokens.refreshToken ?? tokens.accessToken,
            )
          },
        }
      : {}),
  }
}

async function revokeToken(
  fetch: FetchLike,
  definition: OAuth2Definition,
  credentials: ProviderCredentials,
  token: string,
): Promise<void> {
  const url = resolve(definition.revokeUrl!, credentials)
  const init: RequestInit =
    definition.revokeStyle === 'bearer'
      ? { headers: { accept: 'application/json', authorization: `Bearer ${token}` } }
      : {
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token,
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
          }).toString(),
        }
  await vendorRequest(fetch, `${definition.label} revocation`, url, { method: 'POST', ...init })
}

/** Read an id/name pair off a userinfo body with a list of candidate keys. */
export function pickAccount(
  body: Record<string, unknown>,
  idKeys: readonly string[],
  nameKeys: readonly string[],
): ConnectedAccount {
  const id = idKeys.map((key) => str(body[key])).find(Boolean) ?? ''
  const name = nameKeys.map((key) => str(body[key])).find(Boolean) ?? id
  return { id, name }
}
