/**
 * The built-in Connect providers. Each is the generic OAuth 2.0 flow plus the
 * vendor's quirks; the notes say why a quirk exists, because most of them were
 * learned from a connection failing in production.
 */
import type { ConnectCustomProviderConfig, ConnectProviderId } from '../../dsl/connect-config.js'
import {
  asRecord,
  getJson,
  normalizeTokens,
  str,
  tokenRequest,
  vendorRequest,
  type FetchLike,
} from '../http.js'
import {
  verifyDiscordSignature,
  verifyHubSignature,
  verifyHubSpotSignature,
  verifyIntercomSignature,
  verifyLinearSignature,
  verifyNotionSignature,
  verifyShopifyQuery,
  verifyShopifySignature,
  verifySlackSignature,
} from '../signatures.js'
import { GITHUB_HEADERS, githubInstallationToken } from './github-app.js'
import { oauth2, pickAccount } from './oauth2.js'
import type { ConnectTarget, ProviderCredentials, ProviderRuntime } from './types.js'

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'

/* ------------------------------------------------------------------ */
/* GitHub — a GitHub App                                               */
/* ------------------------------------------------------------------ */

type Installation = { id?: number; account?: { login?: string; html_url?: string } | null }

async function githubInstallations(fetch: FetchLike, token: string): Promise<Installation[]> {
  const body = await getJson(
    fetch,
    'GitHub installations',
    'https://api.github.com/user/installations?per_page=100',
    token,
    GITHUB_HEADERS,
  )
  return Array.isArray(body.installations) ? (body.installations as Installation[]) : []
}

function installationTarget(installation: Installation): ConnectTarget {
  return {
    id: String(installation.id),
    name: installation.account?.login || `Installation ${installation.id}`,
    hint: 'GitHub App installation',
  }
}

/**
 * A GitHub App rather than an OAuth App: users pick repositories on GitHub's
 * install screen, one webhook serves every installation, and workspace
 * connections act as the installation instead of borrowing a person's access.
 *
 * The `installation_id` on the install redirect is a public, guessable number,
 * so it is never trusted alone: it must appear in the authorizing user's own
 * installation list, or anyone could bind another organization's installation.
 */
const github: ProviderRuntime = {
  id: 'github',
  label: 'GitHub',
  // The install-and-authorize leg cannot carry our challenge; the client secret protects the exchange.
  pkce: false,
  requiredExtra: ['appSlug'],

  authorizeUrl({ credentials, redirectUri, state }) {
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    return url.toString()
  },

  async continueAuthorization({ credentials, tokens, query, state, fetch }) {
    if (query.get('installation_id')) return null
    if ((await githubInstallations(fetch, tokens.accessToken)).length > 0) return null
    // Authorized but installed nowhere: send them through GitHub's install
    // screen, which returns to the same callback with the same sealed state.
    const url = new URL(
      `https://github.com/apps/${encodeURIComponent(credentials.extra.appSlug ?? '')}/installations/new`,
    )
    url.searchParams.set('state', state)
    return url.toString()
  },

  exchange({ credentials, code, redirectUri, fetch }) {
    return tokenRequest(fetch, 'GitHub token exchange', {
      url: GITHUB_TOKEN_URL,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      auth: 'body',
      params: { code, redirect_uri: redirectUri },
    })
  },

  async refresh({ credentials, tokens, fetch }) {
    if (!tokens.refreshToken) throw new Error('GitHub issued no refresh token.')
    const next = await tokenRequest(fetch, 'GitHub token refresh', {
      url: GITHUB_TOKEN_URL,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      auth: 'body',
      params: { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
    })
    return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken }
  },

  async identify({ tokens, query, scope, fetch }) {
    const user = await getJson(
      fetch,
      'GitHub user',
      'https://api.github.com/user',
      tokens.accessToken,
      GITHUB_HEADERS,
    )
    const login = str(user.login)
    if (scope === 'user') {
      return {
        account: { id: str(user.id), name: login || 'GitHub', url: str(user.html_url) },
        metadata: { login },
      }
    }
    const installations = (await githubInstallations(fetch, tokens.accessToken)).filter(
      (installation) => installation.id != null,
    )
    const requested = query.get('installation_id')
    const only = installations.length === 1 ? installations[0] : undefined
    const chosen = requested
      ? installations.find((installation) => String(installation.id) === requested)
      : only
    if (requested && !chosen) {
      throw new Error(
        'That GitHub installation is not one you can access. Install the app and try again.',
      )
    }
    if (chosen) {
      const target = installationTarget(chosen)
      return {
        account: { id: target.id, name: target.name, url: chosen.account?.html_url ?? '' },
        metadata: { installationId: target.id, login },
      }
    }
    return {
      account: { id: `user:${str(user.id)}`, name: login },
      metadata: { login },
      targets: installations.map(installationTarget),
    }
  },

  async selectTarget({ tokens, target, metadata, fetch }) {
    const installation = (await githubInstallations(fetch, tokens.accessToken)).find(
      (entry) => String(entry.id) === target.id,
    )
    if (!installation) throw new Error('That GitHub installation is no longer available.')
    const chosen = installationTarget(installation)
    return {
      account: { id: chosen.id, name: chosen.name, url: installation.account?.html_url ?? '' },
      metadata: { ...metadata, installationId: chosen.id },
    }
  },

  async mint({ credentials, metadata, scope, fetch }) {
    const issuer = credentials.extra.appId || credentials.clientId
    const installationId = str(metadata.installationId)
    if (scope !== 'workspace' || !installationId || !credentials.extra.privateKey) return null
    return githubInstallationToken(fetch, {
      issuer,
      privateKey: credentials.extra.privateKey,
      installationId,
    })
  },

  async revoke({ credentials, tokens, fetch }) {
    await vendorRequest(
      fetch,
      'GitHub revocation',
      `https://api.github.com/applications/${encodeURIComponent(credentials.clientId)}/grant`,
      {
        method: 'DELETE',
        headers: {
          ...GITHUB_HEADERS,
          authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ access_token: tokens.accessToken }),
      },
    )
  },

  webhook: {
    verify: ({ rawBody, headers, credentials }) =>
      verifyHubSignature(
        rawBody,
        credentials.extra.webhookSecret ?? '',
        headers.get('x-hub-signature-256'),
      ),
    accountId: ({ payload }) => str(asRecord(asRecord(payload).installation).id),
    describe: ({ payload, headers }) => {
      const event = headers.get('x-github-event') ?? ''
      const action = str(asRecord(payload).action)
      return {
        event: action ? `${event}.${action}` : event,
        deliveryId: headers.get('x-github-delivery') ?? '',
      }
    },
  },
}

/* ------------------------------------------------------------------ */
/* Google                                                              */
/* ------------------------------------------------------------------ */

/**
 * A separate grant from Google sign-in on purpose: the mailbox an agent reads
 * need not be the account someone signs in with, and a social sign-in has no
 * Google grant at all.
 */
const google = oauth2({
  id: 'google',
  label: 'Google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  baseScopes: ['openid', 'email'],
  // `prompt=consent` is what makes Google return a refresh token on a second connect.
  authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  userInfo: {
    url: 'https://openidconnect.googleapis.com/v1/userinfo',
    map: (body) => pickAccount(body, ['sub'], ['email', 'name']),
  },
})

/* ------------------------------------------------------------------ */
/* Microsoft                                                           */
/* ------------------------------------------------------------------ */

const microsoftTenant = (credentials: ProviderCredentials) =>
  encodeURIComponent(String(credentials.options.tenant ?? 'common'))
const microsoft = oauth2({
  id: 'microsoft',
  label: 'Microsoft 365',
  authorizeUrl: (credentials) =>
    `https://login.microsoftonline.com/${microsoftTenant(credentials)}/oauth2/v2.0/authorize`,
  tokenUrl: (credentials) =>
    `https://login.microsoftonline.com/${microsoftTenant(credentials)}/oauth2/v2.0/token`,
  baseScopes: ['openid', 'offline_access', 'User.Read'],
  userInfo: {
    url: 'https://graph.microsoft.com/v1.0/me',
    map: (body) => pickAccount(body, ['id'], ['mail', 'userPrincipalName', 'displayName']),
  },
})

/* ------------------------------------------------------------------ */
/* Slack                                                               */
/* ------------------------------------------------------------------ */

const slackBase = oauth2({
  id: 'slack',
  label: 'Slack',
  authorizeUrl: 'https://slack.com/oauth/v2/authorize',
  tokenUrl: 'https://slack.com/api/oauth.v2.access',
  revokeUrl: 'https://slack.com/api/auth.revoke',
  revokeStyle: 'bearer',
  scopeSeparator: ',',
  pkce: false,
})
/** Bot tokens: the connection is the Slack workspace's install, not a person. */
const slack: ProviderRuntime = {
  ...slackBase,
  async identify({ tokens }) {
    const raw = tokens.raw ?? {}
    const team = asRecord(raw.team)
    const teamId = str(team.id)
    if (!teamId) throw new Error('Slack did not say which workspace was installed.')
    return {
      account: {
        id: teamId,
        name: str(team.name) || 'Slack',
        url: `https://app.slack.com/client/${teamId}`,
      },
      metadata: {
        teamId,
        botUserId: str(raw.bot_user_id),
        appId: str(raw.app_id),
        enterpriseId: str(asRecord(raw.enterprise).id),
      },
    }
  },
  webhook: {
    verify: ({ rawBody, headers, credentials }) =>
      verifySlackSignature(rawBody, credentials.extra.signingSecret ?? '', headers),
    accountId: ({ payload }) => {
      const record = asRecord(payload)
      return (
        str(record.team_id) ||
        str(asRecord(record.team).id) ||
        str(asRecord((record.authorizations as unknown[] | undefined)?.[0]).team_id)
      )
    },
    describe: ({ payload, headers }) => {
      const record = asRecord(payload)
      const event = asRecord(record.event)
      return {
        event: record.type === 'event_callback' ? str(event.type) : str(record.type),
        deliveryId: str(record.event_id) || headers.get('x-slack-request-timestamp') || '',
      }
    },
    handshake: ({ payload }) => {
      const record = asRecord(payload)
      return record.type === 'url_verification'
        ? Response.json({ challenge: str(record.challenge) })
        : null
    },
  },
}

/* ------------------------------------------------------------------ */
/* Linear                                                              */
/* ------------------------------------------------------------------ */

const linearBase = oauth2({
  id: 'linear',
  label: 'Linear',
  authorizeUrl: 'https://linear.app/oauth/authorize',
  tokenUrl: 'https://api.linear.app/oauth/token',
  revokeUrl: 'https://api.linear.app/oauth/revoke',
  revokeStyle: 'bearer',
  scopeSeparator: ',',
  authorizeParams: { prompt: 'consent' },
})
const linear: ProviderRuntime = {
  ...linearBase,
  /** Workspace connections act as the app (`actor=app`), not as whoever installed it. */
  authorizeUrl(input) {
    const url = new URL(linearBase.authorizeUrl(input))
    if (input.scope === 'workspace') url.searchParams.set('actor', 'app')
    return url.toString()
  },
  async identify({ tokens, scope, fetch }) {
    const { body } = await vendorRequest(
      fetch,
      'Linear account',
      'https://api.linear.app/graphql',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: 'query { viewer { id name email } organization { id name urlKey } }',
        }),
      },
    )
    const data = asRecord(asRecord(body).data)
    const viewer = asRecord(data.viewer)
    const organization = asRecord(data.organization)
    const url = str(organization.urlKey) ? `https://linear.app/${str(organization.urlKey)}` : ''
    return {
      account:
        scope === 'workspace'
          ? { id: str(organization.id), name: str(organization.name) || 'Linear', url }
          : { id: str(viewer.id), name: str(viewer.email) || str(viewer.name), url },
      metadata: { organizationId: str(organization.id), viewerId: str(viewer.id) },
    }
  },
  webhook: {
    verify: ({ rawBody, headers, credentials, payload }) =>
      verifyLinearSignature(
        rawBody,
        credentials.extra.webhookSecret ?? '',
        headers.get('linear-signature'),
        payload,
      ),
    accountId: ({ payload }) => str(asRecord(payload).organizationId),
    describe: ({ payload, headers }) => {
      const record = asRecord(payload)
      return {
        event: [str(record.type), str(record.action)].filter(Boolean).join('.'),
        deliveryId:
          headers.get('linear-delivery') ?? `${str(record.webhookId)}:${str(record.createdAt)}`,
      }
    },
  },
}

/* ------------------------------------------------------------------ */
/* Notion                                                              */
/* ------------------------------------------------------------------ */

const notionBase = oauth2({
  id: 'notion',
  label: 'Notion',
  authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
  tokenUrl: 'https://api.notion.com/v1/oauth/token',
  tokenAuth: 'basic',
  tokenJson: true,
  pkce: false,
  authorizeParams: { owner: 'user' },
})
const notion: ProviderRuntime = {
  ...notionBase,
  async identify({ tokens }) {
    const raw = tokens.raw ?? {}
    const workspaceId = str(raw.workspace_id)
    return {
      account: { id: workspaceId, name: str(raw.workspace_name) || 'Notion' },
      metadata: { workspaceId, botId: str(raw.bot_id) },
    }
  },
  webhook: {
    verify: ({ rawBody, headers, credentials }) =>
      verifyNotionSignature(
        rawBody,
        credentials.extra.webhookSecret ?? '',
        headers.get('x-notion-signature'),
      ),
    accountId: ({ payload }) => str(asRecord(payload).workspace_id),
    describe: ({ payload }) => {
      const record = asRecord(payload)
      return { event: str(record.type), deliveryId: str(record.id) }
    },
  },
}

/* ------------------------------------------------------------------ */
/* HubSpot                                                             */
/* ------------------------------------------------------------------ */

const hubspotBase = oauth2({
  id: 'hubspot',
  label: 'HubSpot',
  authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
  tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
  pkce: false,
})
const hubspot: ProviderRuntime = {
  ...hubspotBase,
  async identify({ tokens, fetch }) {
    const { body } = await vendorRequest(
      fetch,
      'HubSpot account',
      `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(tokens.accessToken)}`,
    )
    const record = asRecord(body)
    const hubId = str(record.hub_id)
    return {
      account: { id: hubId, name: str(record.hub_domain) || `HubSpot ${hubId}` },
      metadata: { hubId, user: str(record.user) },
    }
  },
  async revoke({ tokens, fetch }) {
    if (!tokens.refreshToken) return
    await vendorRequest(
      fetch,
      'HubSpot revocation',
      `https://api.hubapi.com/oauth/v1/refresh-tokens/${encodeURIComponent(tokens.refreshToken)}`,
      { method: 'DELETE' },
    )
  },
  webhook: {
    verify: ({ request, rawBody, headers, credentials }) =>
      verifyHubSpotSignature(request, rawBody, credentials.clientSecret, headers),
    accountId: ({ payload }) =>
      str(asRecord(Array.isArray(payload) ? payload[0] : payload).portalId),
    describe: ({ payload }) => {
      const first = asRecord(Array.isArray(payload) ? payload[0] : payload)
      return { event: str(first.subscriptionType), deliveryId: str(first.eventId) }
    },
  },
}

/* ------------------------------------------------------------------ */
/* Atlassian                                                           */
/* ------------------------------------------------------------------ */

type AtlassianSite = { id?: string; name?: string; url?: string }

async function atlassianSites(fetch: FetchLike, token: string): Promise<AtlassianSite[]> {
  const { body } = await vendorRequest(
    fetch,
    'Atlassian sites',
    'https://api.atlassian.com/oauth/token/accessible-resources',
    { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
  )
  return Array.isArray(body) ? (body as AtlassianSite[]) : []
}

const atlassianBase = oauth2({
  id: 'atlassian',
  label: 'Atlassian',
  authorizeUrl: 'https://auth.atlassian.com/authorize',
  tokenUrl: 'https://auth.atlassian.com/oauth/token',
  baseScopes: ['offline_access'],
  tokenJson: true,
  pkce: false,
  authorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
})
/** Refresh tokens rotate on every use — the runtime's refresh lease is what keeps two requests from burning one. */
const atlassian: ProviderRuntime = {
  ...atlassianBase,
  async identify({ tokens, scope, fetch }) {
    const me = await getJson(
      fetch,
      'Atlassian account',
      'https://api.atlassian.com/me',
      tokens.accessToken,
    )
    const sites = await atlassianSites(fetch, tokens.accessToken)
    const user = { id: str(me.account_id), name: str(me.email) || str(me.name) }
    if (scope === 'user') return { account: user, metadata: { sites } }
    if (sites.length === 1) {
      const site = sites[0]!
      return {
        account: { id: str(site.id), name: str(site.name), url: str(site.url) },
        metadata: { cloudId: str(site.id), siteUrl: str(site.url) },
      }
    }
    return {
      account: user,
      targets: sites.map((site) => ({
        id: str(site.id),
        name: str(site.name),
        hint: str(site.url),
      })),
    }
  },
  async selectTarget({ tokens, target, metadata, fetch }) {
    const site = (await atlassianSites(fetch, tokens.accessToken)).find(
      (entry) => entry.id === target.id,
    )
    if (!site) throw new Error('That Atlassian site is no longer available to this account.')
    return {
      account: { id: str(site.id), name: str(site.name), url: str(site.url) },
      metadata: { ...metadata, cloudId: str(site.id), siteUrl: str(site.url) },
    }
  },
}

/* ------------------------------------------------------------------ */
/* GitLab                                                              */
/* ------------------------------------------------------------------ */

const gitlabBase = (credentials: ProviderCredentials) =>
  String(credentials.options.baseUrl ?? 'https://gitlab.com').replace(/\/+$/, '')
const gitlab = oauth2({
  id: 'gitlab',
  label: 'GitLab',
  authorizeUrl: (credentials) => `${gitlabBase(credentials)}/oauth/authorize`,
  tokenUrl: (credentials) => `${gitlabBase(credentials)}/oauth/token`,
  revokeUrl: (credentials) => `${gitlabBase(credentials)}/oauth/revoke`,
  baseScopes: ['read_user'],
  userInfo: {
    url: (credentials) => `${gitlabBase(credentials)}/api/v4/user`,
    map: (body) => ({
      id: str(body.id),
      name: str(body.username) || str(body.name),
      url: str(body.web_url),
    }),
  },
})

/* ------------------------------------------------------------------ */
/* Discord                                                             */
/* ------------------------------------------------------------------ */

const discordBase = oauth2({
  id: 'discord',
  label: 'Discord',
  authorizeUrl: 'https://discord.com/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  revokeUrl: 'https://discord.com/api/oauth2/token/revoke',
  pkce: false,
})
/**
 * Installing adds the app's bot to a server. Agents post as that bot, so the
 * token server code receives is the bot token, scoped by the server it joined.
 */
const discord: ProviderRuntime = {
  ...discordBase,
  requiredExtra: ['botToken'],
  authorizeUrl(input) {
    const url = new URL(discordBase.authorizeUrl(input))
    // View channels, send messages, read history, send in threads.
    url.searchParams.set(
      'permissions',
      String(input.credentials.options.permissions ?? '274877975552'),
    )
    return url.toString()
  },
  async identify({ tokens, query }) {
    const guild = asRecord(tokens.raw?.guild)
    const guildId = str(guild.id) || query.get('guild_id') || ''
    if (!guildId) throw new Error('Discord did not say which server the bot joined.')
    return {
      account: { id: guildId, name: str(guild.name) || 'Discord server' },
      metadata: { guildId },
    }
  },
  async mint({ credentials }) {
    return credentials.extra.botToken
      ? { accessToken: credentials.extra.botToken, tokenType: 'Bot' }
      : null
  },
  webhook: {
    verify: ({ rawBody, headers, credentials }) =>
      verifyDiscordSignature(rawBody, credentials.extra.publicKey ?? '', headers),
    accountId: ({ payload }) => str(asRecord(payload).guild_id),
    describe: ({ payload }) => {
      const record = asRecord(payload)
      return { event: `interaction.${str(record.type)}`, deliveryId: str(record.id) }
    },
    handshake: ({ payload }) => (asRecord(payload).type === 1 ? Response.json({ type: 1 }) : null),
  },
}

/* ------------------------------------------------------------------ */
/* Intercom                                                            */
/* ------------------------------------------------------------------ */

const intercom: ProviderRuntime = {
  id: 'intercom',
  label: 'Intercom',
  pkce: false,
  /** Intercom takes no scope or response type; permissions are set on the app. */
  authorizeUrl({ credentials, redirectUri, state }) {
    const url = new URL('https://app.intercom.com/oauth')
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    return url.toString()
  },
  async exchange({ credentials, code, fetch }) {
    const { body } = await vendorRequest(
      fetch,
      'Intercom token exchange',
      'https://api.intercom.io/auth/eagle/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          code,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }).toString(),
      },
    )
    const record = asRecord(body)
    return normalizeTokens('Intercom token exchange', {
      ...record,
      access_token: str(record.access_token) || str(record.token),
    })
  },
  async identify({ tokens, fetch }) {
    const me = await getJson(
      fetch,
      'Intercom account',
      'https://api.intercom.io/me',
      tokens.accessToken,
      {
        'intercom-version': '2.14',
      },
    )
    const app = asRecord(me.app)
    return {
      account: { id: str(app.id_code), name: str(app.name) || 'Intercom' },
      metadata: { appId: str(app.id_code) },
    }
  },
  webhook: {
    verify: ({ rawBody, headers, credentials }) =>
      verifyIntercomSignature(rawBody, credentials.clientSecret, headers.get('x-hub-signature')),
    accountId: ({ payload }) => str(asRecord(payload).app_id),
    describe: ({ payload }) => {
      const record = asRecord(payload)
      return { event: str(record.topic), deliveryId: str(record.id) }
    },
  },
}

/* ------------------------------------------------------------------ */
/* Shopify                                                             */
/* ------------------------------------------------------------------ */

function shopOf(fields: Readonly<Record<string, string>>): string {
  const shop = (fields.shop ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  if (!SHOP_DOMAIN.test(shop)) throw new Error('Enter your store as your-store.myshopify.com.')
  return shop
}

/** One store per connection; the store domain is entered before authorizing. */
const shopify: ProviderRuntime = {
  id: 'shopify',
  label: 'Shopify',
  pkce: false,
  authorizeUrl({ credentials, redirectUri, state, scopes, fields }) {
    const url = new URL(`https://${shopOf(fields)}/admin/oauth/authorize`)
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('scope', scopes.join(','))
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    return url.toString()
  },
  async verifyCallback({ query, credentials, fields }) {
    if (query.get('shop') !== shopOf(fields)) {
      return 'Shopify returned a different store than the one you entered.'
    }
    return (await verifyShopifyQuery(query, credentials.clientSecret))
      ? null
      : 'Shopify’s callback signature did not verify.'
  },
  async exchange({ credentials, code, fields, fetch }) {
    return tokenRequest(fetch, 'Shopify token exchange', {
      url: `https://${shopOf(fields)}/admin/oauth/access_token`,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      auth: 'body',
      json: true,
      params: { code },
    })
  },
  async identify({ fields }) {
    const shop = shopOf(fields)
    return {
      account: {
        id: shop,
        name: shop.replace(/\.myshopify\.com$/, ''),
        url: `https://${shop}/admin`,
      },
      metadata: { shop },
    }
  },
  async revoke({ tokens, metadata, fetch }) {
    const shop = str(metadata.shop)
    if (!SHOP_DOMAIN.test(shop)) return
    await vendorRequest(
      fetch,
      'Shopify revocation',
      `https://${shop}/admin/api_permissions/current.json`,
      {
        method: 'DELETE',
        headers: { 'x-shopify-access-token': tokens.accessToken },
      },
    )
  },
  webhook: {
    verify: ({ rawBody, headers, credentials }) =>
      verifyShopifySignature(
        rawBody,
        credentials.clientSecret,
        headers.get('x-shopify-hmac-sha256'),
      ),
    accountId: ({ headers }) => headers.get('x-shopify-shop-domain') ?? '',
    describe: ({ headers }) => ({
      event: headers.get('x-shopify-topic') ?? '',
      deliveryId: headers.get('x-shopify-event-id') ?? headers.get('x-shopify-webhook-id') ?? '',
    }),
  },
}

export const BUILTIN_PROVIDERS: Record<ConnectProviderId, ProviderRuntime> = {
  atlassian,
  discord,
  github,
  gitlab,
  google,
  hubspot,
  intercom,
  linear,
  microsoft,
  notion,
  shopify,
  slack,
}

/** A `connect.custom` entry as a provider runtime. */
export function customProvider(
  id: string,
  definition: ConnectCustomProviderConfig,
): ProviderRuntime {
  return oauth2({
    id,
    label: definition.label,
    authorizeUrl: definition.authorizeUrl,
    tokenUrl: definition.tokenUrl,
    ...(definition.revokeUrl ? { revokeUrl: definition.revokeUrl } : {}),
    ...(definition.scopeSeparator ? { scopeSeparator: definition.scopeSeparator } : {}),
    ...(definition.tokenAuth ? { tokenAuth: definition.tokenAuth } : {}),
    pkce: definition.pkce ?? true,
    ...(definition.authorizeParams ? { authorizeParams: definition.authorizeParams } : {}),
    ...(definition.userInfoUrl
      ? {
          userInfo: {
            url: definition.userInfoUrl,
            map: (body) =>
              pickAccount(
                body,
                ['id', 'sub', 'user_id', 'account_id'],
                ['email', 'name', 'login', 'username'],
              ),
          },
        }
      : {}),
  })
}
