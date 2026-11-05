import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineBackend, model, orgRows, t } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { compileConfig } from '../src/server/compile/index.js'
import { schemaStatements } from '../src/server/schema-sql.js'
import {
  aad,
  bytesToHex,
  hmacSha256,
  parseKeyring,
  reveal,
  seal,
  sealJson,
} from '../src/connect/crypto.js'
import { ConnectStore, tablesOf } from '../src/connect/store.js'
import { provideAutomationPlatform } from '../src/automations/platform.js'
import type { AutomationRun } from '../src/automations/types.js'
import { decodeState, encodeState, safeReturnTo } from '../src/connect/state.js'
import {
  signConnectPayload,
  verifyConnectSignature,
  verifyHubSignature,
  verifyShopifyQuery,
  verifySlackSignature,
} from '../src/connect/signatures.js'
import { createConnect, onConnectWebhook, type WebhookDelivery } from '../src/connect/runtime.js'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const databases: Database.Database[] = []

afterEach(() => {
  provideAutomationPlatform(undefined)
  vi.unstubAllGlobals()
  for (const db of databases.splice(0)) db.close()
})

describe('sealing', () => {
  it('binds ciphertext to its row and field', async () => {
    const keyring = await parseKeyring(KEY_A, { development: false, envName: 'K' })
    const sealed = await seal(keyring, 'token', aad('connectConnections', 'secrets', 'con_1'))
    expect(sealed.startsWith('enc.v1.k1.')).toBe(true)
    expect(
      (await reveal(keyring, sealed, aad('connectConnections', 'secrets', 'con_1'))).value,
    ).toBe('token')
    await expect(
      reveal(keyring, sealed, aad('connectConnections', 'secrets', 'con_2')),
    ).rejects.toThrow()
    await expect(
      reveal(keyring, sealed, aad('connectConnections', 'webhookSecret', 'con_1')),
    ).rejects.toThrow()
  })

  it('opens values sealed by an older key and flags them for re-sealing', async () => {
    const old = await parseKeyring(`k1:${KEY_A}`, { development: false, envName: 'K' })
    const rotated = await parseKeyring(`k2:${KEY_B},k1:${KEY_A}`, {
      development: false,
      envName: 'K',
    })
    const sealed = await seal(old, 'token', 'x')
    expect(await reveal(rotated, sealed, 'x')).toEqual({ value: 'token', stale: true })
    expect((await reveal(rotated, await seal(rotated, 'token', 'x'), 'x')).stale).toBe(false)
  })

  it('refuses to run without a key outside development', async () => {
    await expect(parseKeyring(undefined, { development: false, envName: 'K' })).rejects.toThrow(
      /K is not set/,
    )
    await expect(parseKeyring('short', { development: false, envName: 'K' })).rejects.toThrow(
      /64 hex/,
    )
    expect((await parseKeyring(undefined, { development: true, envName: 'K' })).development).toBe(
      true,
    )
  })
})

describe('OAuth state', () => {
  it('is bound to the provider and the user that started it', async () => {
    const keyring = await parseKeyring(KEY_A, { development: false, envName: 'K' })
    const state = await encodeState(keyring, {
      provider: 'linear',
      scope: 'user',
      organizationId: null,
      userId: 7,
      returnTo: '/integrations',
      redirectUri: 'https://app.test/api/connect/linear/callback',
      scopes: ['read'],
      verifier: 'v',
    })
    expect(state).not.toContain('integrations')
    expect((await decodeState(keyring, state, { provider: 'linear', userId: 7 }))?.verifier).toBe(
      'v',
    )
    expect(await decodeState(keyring, state, { provider: 'linear', userId: 8 })).toBeNull()
    expect(await decodeState(keyring, state, { provider: 'github', userId: 7 })).toBeNull()
  })

  it('only returns to same-origin paths', () => {
    expect(safeReturnTo('/a?b=1')).toBe('/a?b=1')
    for (const value of ['//evil.test', 'https://evil.test', 'javascript:alert(1)', '/\\evil', 3]) {
      expect(safeReturnTo(value)).toBe('/')
    }
  })
})

describe('webhook signatures', () => {
  it('verifies the vendor envelopes', async () => {
    const body = '{"a":1}'
    const hub = `sha256=${bytesToHex(await hmacSha256('s', body))}`
    expect(await verifyHubSignature(body, 's', hub)).toBe(true)
    expect(await verifyHubSignature(body, 'other', hub)).toBe(false)

    const now = Math.floor(Date.now() / 1000)
    const slack = new Headers({
      'x-slack-request-timestamp': String(now),
      'x-slack-signature': `v0=${bytesToHex(await hmacSha256('s', `v0:${now}:${body}`))}`,
    })
    expect(await verifySlackSignature(body, 's', slack)).toBe(true)
    slack.set('x-slack-request-timestamp', String(now - 3600))
    expect(await verifySlackSignature(body, 's', slack)).toBe(false)

    const query = new URLSearchParams({
      shop: 'a.myshopify.com',
      code: 'c',
      state: 'x',
      timestamp: '1',
    })
    query.set(
      'hmac',
      bytesToHex(await hmacSha256('s', 'code=c&shop=a.myshopify.com&state=x&timestamp=1')),
    )
    expect(await verifyShopifyQuery(query, 's')).toBe(true)

    const envelope = await signConnectPayload(body, 's')
    expect(await verifyConnectSignature(body, 's', envelope)).toBe(true)
    expect(await verifyConnectSignature('{"a":2}', 's', envelope)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* End to end through the backend                                       */
/* ------------------------------------------------------------------ */

const ENV = {
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 'test-only-signing-secret-with-more-than-32-characters',
  CLOUDCONFIG_CONNECT_KEY: KEY_A,
  CONNECT_LINEAR_CLIENT_ID: 'linear-id',
  CONNECT_LINEAR_CLIENT_SECRET: 'linear-secret',
  CONNECT_GITHUB_CLIENT_ID: 'gh-id',
  CONNECT_GITHUB_CLIENT_SECRET: 'gh-secret',
  CONNECT_GITHUB_APP_SLUG: 'test-app',
  CONNECT_GITHUB_WEBHOOK_SECRET: 'gh-hook-secret',
}

function setup(options: { mcpServers?: readonly string[]; durableWebhooks?: boolean } = {}) {
  const config = defineBackend({
    auth: { emailPassword: true, devIdp: false, proxy: false, organizations: true },
    connect: {
      providers: { linear: { mcpServers: options.mcpServers ?? [] }, github: true },
      mcp: true,
      ...(options.durableWebhooks ? { webhooks: { task: 'webhook' } } : {}),
    },
    ...(options.durableWebhooks
      ? {
          deploy: {
            target: 'vercel' as const,
            automations: { entry: 'server/automations.ts' },
          },
        }
      : {}),
    models: {
      note: model(
        { title: t.text(), organizationId: t.number().required() },
        { access: { list: ({ user, where }) => orgRows(user, where), create: () => true } },
      ),
    },
  })
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  const base = compileConfig(config)
  for (const entry of schemaStatements(base)) sqlite.exec(entry.sql)
  const db = drizzle(sqlite)
  const app = createBackend(config, { db: { id: 'test', connect: () => db } })
  const call = async (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (!headers.has('origin')) headers.set('origin', 'http://localhost')
    if (init.cookie) headers.set('cookie', init.cookie)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    return app.fetch(
      new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }),
      ENV,
    )
  }
  return { base, sqlite, db, call }
}

type Harness = ReturnType<typeof setup>

async function storedConnection(
  harness: Harness,
  options: { key: string; expiresAt?: number; refreshToken?: string },
) {
  const uid = crypto.randomUUID()
  const keyring = await parseKeyring(options.key, { development: false, envName: 'K' })
  const secrets = await sealJson(
    keyring,
    {
      accessToken: 'private-token',
      ...(options.refreshToken ? { refreshToken: options.refreshToken } : {}),
    },
    aad('connectConnections', 'secrets', uid),
  )
  const [row] = await harness.db
    .insert(tablesOf(harness.base).connection)
    .values({
      uid,
      provider: 'linear',
      kind: 'oauth',
      scope: 'workspace',
      status: 'active',
      secrets,
      expiresAt: options.expiresAt ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .returning()
  return row!
}

describe('Connect maintenance', () => {
  it('finds older encryption keys behind current-key rows and walks bounded batches without starvation', async () => {
    const harness = setup()
    for (let index = 0; index < 6; index++) await storedConnection(harness, { key: `k2:${KEY_B}` })
    const old = await storedConnection(harness, { key: `k1:${KEY_A}` })
    const env = { ...ENV, CLOUDCONFIG_CONNECT_KEY: `k2:${KEY_B},k1:${KEY_A}` }
    const currentClients = new ConnectStore(
      harness.base,
      harness.db,
      await parseKeyring(`k2:${KEY_B}`, { development: false, envName: 'K' }),
    )
    for (let index = 0; index < 6; index++) {
      await currentClients.insertClient({
        uid: `current-${index}`,
        issuer: `https://mcp-${index}.test`,
        redirectUri: 'https://app.test/callback',
        clientId: 'client',
        clientSecret: 'private-mcp-secret',
        metadata: {},
      })
    }
    const oldClients = new ConnectStore(
      harness.base,
      harness.db,
      await parseKeyring(`k1:${KEY_A}`, { development: false, envName: 'K' }),
    )
    await oldClients.insertClient({
      uid: 'old-client',
      issuer: 'https://old-mcp.test',
      redirectUri: 'https://app.test/callback',
      clientId: 'client',
      clientSecret: 'old-private-mcp-secret',
      metadata: {},
    })
    const connect = createConnect(harness.base, { db: harness.db, env })
    expect(await connect.maintain({ limit: 1 })).toMatchObject({ resealed: 2, failed: 0 })
    const store = new ConnectStore(
      harness.base,
      harness.db,
      await parseKeyring(env.CLOUDCONFIG_CONNECT_KEY, { development: false, envName: 'K' }),
    )
    expect((await store.find(old.id))!.secrets).toMatch(/^enc.v1.k2\./)
    const client = (await store.findClientByUid('old-client'))!
    expect(client.secret).toMatch(/^enc.v1.k2\./)
    expect(await store.openClientSecret(client)).toBe('old-private-mcp-secret')
    const visited: number[] = []
    let afterId = 0
    do {
      const result = await connect.maintain({ limit: 2, afterId, afterClientId: afterId })
      expect(result.nextClientCursor).toEqual(result.nextCursor)
      if (result.nextCursor === null) break
      expect(result.nextCursor).toBeGreaterThan(afterId)
      afterId = result.nextCursor!
      visited.push(afterId)
    } while (visited.length < 10)
    expect(visited).toEqual([2, 4, 6])
  })

  it('refreshes expiring grants, preserves refreshed ciphertext during rotation, and marks nonrefreshable expired grants', async () => {
    const harness = setup()
    const expiring = await storedConnection(harness, {
      key: `k1:${KEY_A}`,
      expiresAt: Date.now() - 1000,
      refreshToken: 'refresh-me',
    })
    const expired = await storedConnection(harness, {
      key: `k1:${KEY_A}`,
      expiresAt: Date.now() - 1000,
    })
    const calls = stubVendor(linearVendor({ access: 'new', refresh: 'rotated', expiresIn: 3600 }))
    const env = { ...ENV, CLOUDCONFIG_CONNECT_KEY: `k2:${KEY_B},k1:${KEY_A}` }
    const connect = createConnect(harness.base, { db: harness.db, env })
    expect(await connect.maintain({ limit: 5, afterId: 0 })).toMatchObject({
      refreshed: 1,
      failed: 1,
      nextCursor: null,
    })
    expect(calls).toEqual(['POST https://api.linear.app/oauth/token'])
    const store = new ConnectStore(
      harness.base,
      harness.db,
      await parseKeyring(env.CLOUDCONFIG_CONNECT_KEY, { development: false, envName: 'K' }),
    )
    const refreshed = (await store.find(expiring.id))!
    expect((await store.openSecrets(refreshed)).secrets.accessToken).toBe('new-refreshed')
    expect(refreshed.secrets).toMatch(/^enc.v1.k2\./)
    expect(await store.find(expired.id)).toMatchObject({
      status: 'error',
      statusMessage: 'The token expired. Reconnect the account.',
    })
    await expect(
      connect.maintain({ afterId: 0, signal: AbortSignal.abort(new Error('Cancelled')) }),
    ).rejects.toThrow('Cancelled')
  })
})

function mergeCookies(current: string, response: Response): string {
  const jar = new Map(
    current
      .split('; ')
      .filter(Boolean)
      .map((entry) => [entry.slice(0, entry.indexOf('=')), entry] as const),
  )
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0]!
    jar.set(pair.slice(0, pair.indexOf('=')), pair)
  }
  return [...jar.values()].join('; ')
}

async function signUp(harness: Harness, email: string) {
  const response = await harness.call('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ name: email, email, password: 'test-password-12345' }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const body = (await response.json()) as { user: { id: string } }
  return { id: Number(body.user.id), cookie: mergeCookies('', response) }
}

async function createOrganization(harness: Harness, cookie: string, slug: string) {
  const created = await harness.call('/api/auth/organization/create', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ name: slug, slug }),
  })
  expect(created.status, await created.clone().text()).toBe(200)
  const organization = (await created.json()) as { id: string }
  const active = await harness.call('/api/auth/organization/set-active', {
    method: 'POST',
    cookie: mergeCookies(cookie, created),
    body: JSON.stringify({ organizationId: organization.id }),
  })
  expect(active.status, await active.clone().text()).toBe(200)
  return {
    id: Number(organization.id),
    cookie: mergeCookies(mergeCookies(cookie, created), active),
  }
}

async function joinOrganization(
  harness: Harness,
  user: { id: number; cookie: string },
  organizationId: number,
  role: string,
) {
  harness.sqlite
    .prepare('INSERT INTO members (organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(organizationId, user.id, role, Math.floor(Date.now() / 1000))
  const active = await harness.call('/api/auth/organization/set-active', {
    method: 'POST',
    cookie: user.cookie,
    body: JSON.stringify({ organizationId: String(organizationId) }),
  })
  expect(active.status, await active.clone().text()).toBe(200)
  return mergeCookies(user.cookie, active)
}

type Route = (
  url: URL,
  init: RequestInit | undefined,
) => Response | undefined | Promise<Response | undefined>

function stubVendor(routes: Route) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`)
    const answer = await routes(url, init)
    if (!answer) throw new Error(`unexpected vendor call: ${url}`)
    return answer
  })
  return calls
}

function linearVendor(tokens: { access: string; refresh: string; expiresIn?: number }) {
  return (url: URL, init: RequestInit | undefined) => {
    if (url.href === 'https://api.linear.app/oauth/token') {
      const body = new URLSearchParams(String(init?.body))
      return Response.json({
        access_token:
          body.get('grant_type') === 'refresh_token' ? `${tokens.access}-refreshed` : tokens.access,
        refresh_token: `${tokens.refresh}-${body.get('grant_type')}`,
        expires_in: tokens.expiresIn ?? 3600,
        scope: 'read,write',
        token_type: 'Bearer',
      })
    }
    if (url.href === 'https://api.linear.app/graphql') {
      return Response.json({
        data: {
          viewer: { id: 'u1', name: 'Ada', email: 'ada@linear.test' },
          organization: { id: 'org-linear', name: 'Acme', urlKey: 'acme' },
        },
      })
    }
    return undefined
  }
}

async function connectLinear(harness: Harness, cookie: string, scope: 'user' | 'workspace') {
  const start = await harness.call('/api/connect/linear/start', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ scope, returnTo: '/integrations' }),
  })
  expect(start.status, await start.clone().text()).toBe(200)
  const { url } = (await start.json()) as { url: string }
  const authorize = new URL(url)
  expect(authorize.origin).toBe('https://linear.app')
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  if (scope === 'workspace') expect(authorize.searchParams.get('actor')).toBe('app')
  const state = authorize.searchParams.get('state')!
  const callback = await harness.call(
    `/api/connect/linear/callback?code=abc&state=${encodeURIComponent(state)}`,
    {
      cookie,
    },
  )
  expect(callback.status).toBe(302)
  return new URL(callback.headers.get('location')!, 'http://localhost')
}

describe('Connect end to end', () => {
  it('uses an existing OAuth grant only at declared MCP endpoints, with the same owner checks', async () => {
    const server = 'https://mcp.test/mcp'
    const harness = setup({ mcpServers: [server] })
    const ada = await signUp(harness, 'ada@example.com')
    const bob = await signUp(harness, 'bob@example.com')
    const vendor = linearVendor({ access: 'oauth-at', refresh: 'oauth-rt' })
    const calls = stubVendor((url, init) => {
      if (url.href !== server) return vendor(url, init)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-at')
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {} }
          : { tools: [{ name: 'read_events', inputSchema: { type: 'object' } }] }
      return Response.json({ jsonrpc: '2.0', id: message.id, result })
    })
    const landed = await connectLinear(harness, ada.cookie, 'user')
    const connectionId = Number(landed.searchParams.get('connection'))
    const connect = createConnect(harness.base, { db: harness.db, env: ENV })
    const actor = { userId: ada.id, organizationId: null, role: '' }

    expect((await connect.get(actor, connectionId)).kind).toBe('oauth')
    expect(await connect.mcp(actor, connectionId, { server }).listTools()).toMatchObject([
      { name: 'read_events' },
    ])
    expect(calls.some((call) => call.includes('/register'))).toBe(false)

    const previousCalls = calls.length
    for (const endpoint of ['https://evil.test/mcp', `${server}/other`, `${server}?admin=true`]) {
      await expect(
        connect.mcp(actor, connectionId, { server: endpoint }).listTools(),
      ).rejects.toThrow(/does not allow its tokens/)
    }
    await expect(connect.mcp(actor, connectionId).listTools()).rejects.toThrow(
      /configured MCP endpoint/,
    )
    await expect(
      connect
        .mcp({ userId: bob.id, organizationId: null, role: '' }, connectionId, { server })
        .listTools(),
    ).rejects.toThrow()
    await expect(
      connect
        .mcp(actor, connectionId, {
          server,
          signal: AbortSignal.abort(new Error('Run cancelled')),
        })
        .listTools(),
    ).rejects.toThrow('Run cancelled')
    expect(calls).toHaveLength(previousCalls)
  })

  it('rejects unsafe configured MCP token destinations', () => {
    for (const endpoint of [
      'http://mcp.test',
      'https://user:secret@mcp.test',
      'https://mcp.test/#fragment',
      'invalid',
    ]) {
      expect(() => setup({ mcpServers: [endpoint] })).toThrow(/HTTPS endpoint URLs/)
    }
  })

  it('keeps a shared OAuth grant usable when an MCP service rejects access', async () => {
    for (const status of [403, 401]) {
      const server = 'https://mcp.test/mcp'
      const harness = setup({ mcpServers: [server] })
      const ada = await signUp(harness, 'ada@example.com')
      const vendor = linearVendor({ access: 'oauth-at', refresh: 'oauth-rt' })
      const calls = stubVendor((url, init) => {
        if (url.href === server) return new Response('Access denied', { status })
        return vendor(url, init)
      })
      const landed = await connectLinear(harness, ada.cookie, 'user')
      const connectionId = Number(landed.searchParams.get('connection'))
      const connect = createConnect(harness.base, { db: harness.db, env: ENV })
      const actor = { userId: ada.id, organizationId: null, role: '' }

      await expect(connect.mcp(actor, connectionId, { server }).listTools()).rejects.toThrow(
        /MCP server/,
      )
      expect((await connect.get(actor, connectionId)).status).toBe('active')
      expect((await connect.access(actor, connectionId)).accessToken).toBe(
        status === 401 ? 'oauth-at-refreshed' : 'oauth-at',
      )
      expect(calls.filter((call) => call === `POST ${server}`)).toHaveLength(status === 401 ? 2 : 1)
    }
  })

  it('connects through OAuth, seals tokens, and never returns them', async () => {
    const harness = setup()
    const ada = await signUp(harness, 'ada@example.com')
    const org = await createOrganization(harness, ada.cookie, 'acme')
    stubVendor(linearVendor({ access: 'at', refresh: 'rt' }))

    const providers = (await (await harness.call('/api/connect/providers')).json()) as {
      providers: { id: string; configured: boolean }[]
    }
    expect(providers.providers.find((entry) => entry.id === 'linear')?.configured).toBe(true)

    const landed = await connectLinear(harness, org.cookie, 'workspace')
    expect(landed.pathname).toBe('/integrations')
    expect(landed.searchParams.get('connect')).toBe('connected')
    const id = Number(landed.searchParams.get('connection'))

    const listed = await harness.call('/api/connect/connections', { cookie: org.cookie })
    const text = await listed.text()
    expect(text).not.toContain('"at"')
    expect(text).not.toContain('rt-')
    const { data } = JSON.parse(text) as {
      data: { id: number; account: { name: string }; scope: string; canManage: boolean }[]
    }
    expect(data).toMatchObject([
      { id, scope: 'workspace', account: { name: 'Acme' }, canManage: true },
    ])

    const row = harness.sqlite
      .prepare('SELECT secrets, organization_id FROM connectConnections')
      .get() as {
      secrets: string
      organization_id: number
    }
    expect(row.secrets.startsWith('enc.v1.')).toBe(true)
    expect(row.organization_id).toBe(org.id)

    const connect = createConnect(harness.base, { db: harness.db, env: ENV })
    const access = await connect.access(
      { userId: ada.id, organizationId: org.id, role: 'owner' },
      id,
    )
    expect(access.accessToken).toBe('at')
  })

  it('refreshes once when many runs ask at the same time', async () => {
    const harness = setup()
    const ada = await signUp(harness, 'ada@example.com')
    const org = await createOrganization(harness, ada.cookie, 'acme')
    const calls = stubVendor(linearVendor({ access: 'at', refresh: 'rt', expiresIn: 60 }))
    const landed = await connectLinear(harness, org.cookie, 'workspace')
    const id = Number(landed.searchParams.get('connection'))

    const connect = createConnect(harness.base, { db: harness.db, env: ENV })
    const actor = { userId: ada.id, organizationId: org.id, role: 'owner' }
    const results = await Promise.all([1, 2, 3].map(() => connect.access(actor, id)))
    expect(results.map((result) => result.accessToken)).toEqual([
      'at-refreshed',
      'at-refreshed',
      'at-refreshed',
    ])
    expect(calls.filter((call) => call === 'POST https://api.linear.app/oauth/token')).toHaveLength(
      2,
    )
  })

  it('refreshes an expiring grant that is still sealed under a retired key', async () => {
    const harness = setup()
    const ada = await signUp(harness, 'ada@example.com')
    const org = await createOrganization(harness, ada.cookie, 'acme')
    stubVendor(linearVendor({ access: 'at', refresh: 'rt', expiresIn: 60 }))
    const landed = await connectLinear(harness, org.cookie, 'workspace')
    const env = { ...ENV, CLOUDCONFIG_CONNECT_KEY: `k2:${KEY_B},k1:${KEY_A}` }
    const connect = createConnect(harness.base, { db: harness.db, env })
    const access = await connect.access(
      { userId: ada.id, organizationId: org.id, role: 'owner' },
      Number(landed.searchParams.get('connection')),
    )
    expect(access.accessToken).toBe('at-refreshed')
  })

  it('shares workspace connections with members and keeps user connections private', async () => {
    const harness = setup()
    const ada = await signUp(harness, 'ada@example.com')
    const org = await createOrganization(harness, ada.cookie, 'acme')
    stubVendor(linearVendor({ access: 'at', refresh: 'rt' }))
    const shared = Number(
      (await connectLinear(harness, org.cookie, 'workspace')).searchParams.get('connection'),
    )
    const personal = Number(
      (await connectLinear(harness, org.cookie, 'user')).searchParams.get('connection'),
    )
    expect(personal).not.toBe(shared)

    const grace = await signUp(harness, 'grace@example.com')
    const graceCookie = await joinOrganization(harness, grace, org.id, 'member')
    const listed = (await (
      await harness.call('/api/connect/connections', { cookie: graceCookie })
    ).json()) as {
      data: { id: number; canManage: boolean }[]
    }
    expect(listed.data).toEqual([expect.objectContaining({ id: shared, canManage: false })])
    expect(
      (
        await harness.call(`/api/connect/connections/${shared}`, {
          method: 'DELETE',
          cookie: graceCookie,
        })
      ).status,
    ).toBe(403)
    expect(
      (await harness.call(`/api/connect/connections/${personal}`, { cookie: graceCookie })).status,
    ).toBe(404)
    const memberStart = await harness.call('/api/connect/linear/start', {
      method: 'POST',
      cookie: graceCookie,
      body: JSON.stringify({ scope: 'workspace' }),
    })
    expect(memberStart.status).toBe(403)

    const connect = createConnect(harness.base, { db: harness.db, env: ENV })
    const member = { userId: grace.id, organizationId: org.id, role: 'member' }
    expect((await connect.access(member, shared)).accessToken).toBe('at')
    await expect(connect.access(member, personal)).rejects.toThrow(/not found/)

    // Leaving the organization ends access immediately and deletes their own connections.
    harness.sqlite.prepare('DELETE FROM members WHERE user_id = ?').run(grace.id)
    expect(await connect.actorFor({ userId: grace.id, organizationId: org.id })).toBeNull()
    expect((await harness.call('/api/connect/connections', { cookie: graceCookie })).status).toBe(
      200,
    )
    expect(
      (
        (await (
          await harness.call('/api/connect/connections', { cookie: graceCookie })
        ).json()) as { data: unknown[] }
      ).data,
    ).toEqual([])
    expect(await connect.offboard({ userId: ada.id, organizationId: org.id })).toBe(1)
    expect(
      (await connect.list({ userId: ada.id, organizationId: org.id, role: 'owner' })).map(
        (entry) => entry.id,
      ),
    ).toEqual([shared])
  })

  it('scopes rows to the active organization with orgRows', async () => {
    const harness = setup()
    const ada = await signUp(harness, 'ada@example.com')
    const first = await createOrganization(harness, ada.cookie, 'first')
    harness.sqlite
      .prepare(
        "INSERT INTO notes (title, organization_id, created_at, updated_at) VALUES ('a', ?, '', ''), ('b', 999, '', '')",
      )
      .run(first.id)
    const notes = (await (await harness.call('/api/notes', { cookie: first.cookie })).json()) as {
      data: { title: string }[]
    }
    expect(notes.data.map((note) => note.title)).toEqual(['a'])
    expect((await harness.call('/api/notes', { cookie: ada.cookie })).status).toBe(403)
  })

  it('reports a failed callback on the return URL instead of a dead end', async () => {
    const harness = setup()
    const ada = await signUp(harness, 'ada@example.com')
    const forged = await harness.call('/api/connect/linear/callback?code=abc&state=forged', {
      cookie: ada.cookie,
    })
    expect(forged.status).toBe(302)
    expect(
      new URL(forged.headers.get('location')!, 'http://localhost').searchParams.get(
        'connect_error',
      ),
    ).toMatch(/expired/)
    const crossSite = await harness.call('/api/connect/linear/start', {
      method: 'POST',
      cookie: ada.cookie,
      headers: { origin: 'https://evil.test' },
      body: JSON.stringify({}),
    })
    expect(crossSite.status).toBe(403)
  })

  it('dispatches verified GitHub App webhooks to the installation’s connection', async () => {
    const harness = setup({ durableWebhooks: true })
    const startRun = vi.fn(async (run: AutomationRun) => ({
      runId: run.runId,
      status: 'queued' as const,
      output: null,
      error: '',
    }))
    const runs = vi.fn(async () => ({
      start: startRun,
      status: vi.fn(),
      resume: vi.fn(),
      signal: vi.fn(),
      cancel: vi.fn(),
    }))
    provideAutomationPlatform(() => ({ runs, schedule: vi.fn(), configure: vi.fn() }))
    const ada = await signUp(harness, 'ada@example.com')
    const org = await createOrganization(harness, ada.cookie, 'acme')
    stubVendor((url) => {
      if (url.href === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'ghu' })
      }
      if (url.href === 'https://api.github.com/user') return Response.json({ id: 1, login: 'ada' })
      if (url.pathname === '/user/installations') {
        return Response.json({
          installations: [
            { id: 42, account: { login: 'acme', html_url: 'https://github.com/acme' } },
          ],
        })
      }
      return undefined
    })
    const start = await harness.call('/api/connect/github/start', {
      method: 'POST',
      cookie: org.cookie,
      body: JSON.stringify({ scope: 'workspace' }),
    })
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')!
    const callback = await harness.call(
      `/api/connect/github/callback?code=c&installation_id=42&setup_action=install&state=${encodeURIComponent(state)}`,
      { cookie: org.cookie },
    )
    expect(
      new URL(callback.headers.get('location')!, 'http://localhost').searchParams.get('connect'),
    ).toBe('connected')

    const deliveries: WebhookDelivery[] = []
    const stop = onConnectWebhook((delivery) => {
      deliveries.push(delivery)
    })
    try {
      const body = JSON.stringify({ action: 'opened', installation: { id: 42 } })
      const signature = `sha256=${bytesToHex(await hmacSha256('gh-hook-secret', body))}`
      const forged = await harness.call('/api/connect/hooks/github', {
        method: 'POST',
        headers: { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=00' },
        body,
      })
      expect(forged.status).toBe(401)
      expect(startRun).not.toHaveBeenCalled()
      const delivered = await harness.call('/api/connect/hooks/github', {
        method: 'POST',
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': 'd1',
          'x-hub-signature-256': signature,
        },
        body,
      })
      expect(delivered.status).toBe(202)
      expect(runs).toHaveBeenCalledWith({ ownerId: null, workspace: `organization:${org.id}` })
      expect(startRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.stringMatching(/^webhook_/),
          task: 'webhook',
          payload: expect.objectContaining({ provider: 'github', deliveryId: 'd1' }),
        }),
      )
      const accepted = startRun.mock.calls[0]!
      const retried = await harness.call('/api/connect/hooks/github', {
        method: 'POST',
        body,
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': 'd1',
          'x-hub-signature-256': signature,
        },
      })
      expect(retried.status).toBe(202)
      expect(startRun.mock.calls[1]).toEqual(accepted)
      expect(JSON.stringify(accepted)).not.toMatch(/ghu|gh-hook-secret|linear-secret/)
      expect(deliveries[0]).toMatchObject({
        provider: 'github',
        event: 'issues.opened',
        deliveryId: 'd1',
        connection: { organizationId: org.id, account: { id: '42' } },
      })
      startRun.mockRejectedValueOnce(new Error('Native queue temporarily unavailable'))
      const unavailable = await harness.call('/api/connect/hooks/github', {
        method: 'POST',
        body,
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': 'd2',
          'x-hub-signature-256': signature,
        },
      })
      expect(unavailable.status).toBe(500)
    } finally {
      stop()
    }
  })

  it('connects a hosted MCP server with dynamic client registration', async () => {
    const harness = setup()
    const ada = await signUp(harness, 'ada@example.com')
    const registrations: unknown[] = []
    stubVendor(async (url, init) => {
      if (url.href === 'https://mcp.test/mcp' && init?.method === 'POST') {
        const auth = new Headers(init.headers).get('authorization')
        if (!auth) {
          return new Response(null, {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
            },
          })
        }
        const message = JSON.parse(String(init.body)) as { id?: number; method: string }
        if (message.id === undefined) return new Response(null, { status: 202 })
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test' } }
            : {
                tools: [
                  {
                    name: 'search',
                    inputSchema: { type: 'object' },
                    annotations: { readOnlyHint: true },
                  },
                ],
              }
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`,
          {
            headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' },
          },
        )
      }
      if (url.href === 'https://mcp.test/mcp' && init?.method === 'DELETE') {
        return new Response(null, { status: 200 })
      }
      if (url.href === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') {
        return Response.json({
          resource: 'https://mcp.test/mcp',
          authorization_servers: ['https://auth.mcp.test'],
        })
      }
      if (url.href === 'https://auth.mcp.test/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: 'https://auth.mcp.test',
          authorization_endpoint: 'https://auth.mcp.test/authorize',
          token_endpoint: 'https://auth.mcp.test/token',
          registration_endpoint: 'https://auth.mcp.test/register',
          code_challenge_methods_supported: ['S256'],
        })
      }
      if (url.href === 'https://auth.mcp.test/register') {
        registrations.push(JSON.parse(String(init?.body)))
        return Response.json({ client_id: 'dyn-client' })
      }
      if (url.href === 'https://auth.mcp.test/token') {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('resource')).toBe('https://mcp.test/mcp')
        expect(body.get('code_verifier')).toBeTruthy()
        return Response.json({ access_token: 'mcp-at', refresh_token: 'mcp-rt', expires_in: 3600 })
      }
      return undefined
    })
    const start = await harness.call('/api/connect/mcp/start', {
      method: 'POST',
      cookie: ada.cookie,
      body: JSON.stringify({ fields: { server: 'https://mcp.test/mcp' }, label: 'Test MCP' }),
    })
    expect(start.status, await start.clone().text()).toBe(200)
    const authorize = new URL(((await start.json()) as { url: string }).url)
    expect(authorize.searchParams.get('client_id')).toBe('dyn-client')
    expect(authorize.searchParams.get('resource')).toBe('https://mcp.test/mcp')
    expect(registrations).toHaveLength(1)
    const callback = await harness.call(
      `/api/connect/mcp/callback?code=c&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { cookie: ada.cookie },
    )
    const landed = new URL(callback.headers.get('location')!, 'http://localhost')
    expect(landed.searchParams.get('connect')).toBe('connected')
    const id = Number(landed.searchParams.get('connection'))
    const tools = (await (
      await harness.call(`/api/connect/connections/${id}/tools`, { cookie: ada.cookie })
    ).json()) as {
      tools: { name: string }[]
    }
    expect(tools.tools.map((tool) => tool.name)).toEqual(['search'])
  })
})
