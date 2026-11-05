/**
 * The Connect runtime: who may use which connection, the OAuth and MCP flows,
 * token refresh, webhooks, offboarding and maintenance.
 *
 * Policy, in one place:
 * - A `user` connection acts as the person who connected it, inside the
 *   organization (or personal space) it was made in. Only that person's runs
 *   may use it — never a teammate's agent.
 * - A `workspace` connection belongs to an organization. Any current member's
 *   runs may use it; only `managerRoles` may add or remove one.
 * - Membership is checked on every use, so removing someone revokes their
 *   access at once, and their user connections are deleted at the vendor.
 */
import { and, eq, getTableColumns, gt, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { CloudConfigUser } from '../dsl/filters.js'
import type { ConnectionScope } from '../dsl/connect-config.js'
import type { CompiledBase } from '../server/compile/index.js'
import type { Db } from '../server/driver.js'
import { isDevelopment, readEnv } from '../server/auth/env.js'
import { membershipLookup } from '../server/auth/membership.js'
import {
  connectCallbackUrl,
  MCP_PROVIDER_ID,
  type ResolvedConnect,
  type ResolvedConnectProvider,
} from '../shared/connect-resolve.js'
import type { ConnectionSummary, ProviderSummary } from '../shared/connect-types.js'
import { enqueueConnectWebhook } from './automations.js'
import {
  parseKeyring,
  pkcePair,
  randomHex,
  randomId,
  sealPrefix,
  timingSafeEqual,
  type Keyring,
} from './crypto.js'
import { ProviderError, ReauthorizeError, type FetchLike, type TokenSet } from './http.js'
import {
  assertMcpUrl,
  callMcpTool,
  clientMetadataDocument,
  discoverMcpServer,
  isLoopbackHost,
  listMcpTools,
  McpSession,
  mcpAuthorizeUrl,
  mcpRevoke,
  mcpTokenRequest,
  registerMcpClient,
  type McpCallResult,
  type McpClient,
  type McpTool,
} from './mcp.js'
import { BUILTIN_PROVIDERS, customProvider } from './providers/builtin.js'
import type { ConnectTarget, ProviderCredentials, ProviderRuntime } from './providers/types.js'
import { verifyConnectSignature, verifyHubSignature } from './signatures.js'
import { decodeState, encodeState, safeReturnTo, type FlowState } from './state.js'
import {
  ConnectStore,
  parseMetadata,
  tokenColumns,
  type ClientRow,
  type ConnectionInsert,
  type ConnectionKind,
  type ConnectionRow,
  type ConnectionStatus,
  type StoredSecrets,
} from './store.js'

export type { ConnectionSummary, ProviderSummary }

/** Refresh this long before a token lapses. */
const REFRESH_SKEW_MS = 5 * 60 * 1000
/** Maintenance refreshes further ahead, so runs between two passes rarely wait on a vendor. */
const MAINTENANCE_REFRESH_WINDOW_MS = 3 * REFRESH_SKEW_MS
/** Setups nobody finished (a target never chosen) are dropped after a day. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000
const LEASE_MS = 30_000
const LEASE_WAIT_MS = 10_000
const LEASE_POLL_MS = 250
const LAST_USED_GRANULARITY_MS = 5 * 60 * 1000
const MAX_SECRET_BYTES = 16_000
const MAX_EVENT_BYTES = 2_000_000
const MAX_LABEL_LENGTH = 120
const MAX_MESSAGE_LENGTH = 300
/** Stored in place of a registration uid when the MCP client is a CIMD URL. */
const METADATA_CLIENT_REF = 'cimd'

export class ConnectError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 502 | 503 = 400,
    /** `reauthorize` when the user has to connect the account again. */
    readonly code: '' | 'reauthorize' | 'not_configured' = '',
  ) {
    super(message)
  }
}

/** Who is using a connection: a signed-in person, or a job running on their behalf. */
export interface ConnectActor {
  userId: number
  /** The organization the request or job acts in; `null` is the personal space. */
  organizationId: number | null
  /** Role in that organization, comma-separated; empty outside one. */
  role: string
}

export interface ConnectAccess {
  connection: ConnectionSummary
  accessToken: string
  tokenType: string
  expiresAt: number | null
  /** API-key connections: the fields the user entered. */
  fields: Record<string, string>
  metadata: Record<string, unknown>
}

export interface WebhookDelivery {
  provider: string
  event: string
  deliveryId: string
  payload: unknown
  connection: ConnectionSummary
}

export type ConnectWebhookHandler = (
  delivery: WebhookDelivery,
  context: { env: Record<string, unknown> | undefined; request: Request },
) => void | Promise<void>

const webhookHandlers = new Set<ConnectWebhookHandler>()

/**
 * Receive verified vendor webhooks. Register once at server start (a Nitro
 * plugin, a Worker module scope); returns an unregister function.
 */
export function onConnectWebhook(handler: ConnectWebhookHandler): () => void {
  webhookHandlers.add(handler)
  return () => webhookHandlers.delete(handler)
}

export function actorFromUser(user: CloudConfigUser | null | undefined): ConnectActor | null {
  if (!user || typeof user.id !== 'number') return null
  return {
    userId: user.id,
    organizationId: user.organization?.id ?? null,
    role: user.organization?.role ?? '',
  }
}

function hasRole(role: string, roles: readonly string[]): boolean {
  return role.split(',').some((entry) => roles.includes(entry.trim()))
}

export interface ConnectOptions {
  db: Db
  env?: Record<string, unknown> | undefined
  /** Injected in tests; defaults to the global fetch. */
  fetch?: FetchLike
}

export type Connect = ReturnType<typeof createConnect>

export interface ConnectMaintenanceResult {
  refreshed: number
  failed: number
  resealed: number
  removed: number
  nextCursor?: number | null
  nextClientCursor?: number | null
}

/**
 * The Connect API for one request or job. Cheap to create; keep one per
 * request so the environment (Worker secrets) is the request's own.
 */
export function createConnect(base: CompiledBase, options: ConnectOptions) {
  const resolved = base.connect
  if (!resolved) {
    throw new ConnectError(
      'Connect is not configured. Add a connect block to cloud.config.ts.',
      503,
      'not_configured',
    )
  }
  const config: ResolvedConnect = resolved
  const env = options.env
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const development = isDevelopment(env)
  let keyringPromise: Promise<Keyring> | undefined
  let storePromise: Promise<ConnectStore> | undefined

  const keyring = () =>
    (keyringPromise ??= parseKeyring(readEnv(config.keyEnv, env), {
      development,
      envName: config.keyEnv,
    }))
  const store = () =>
    (storePromise ??= keyring().then((ring) => new ConnectStore(base, options.db, ring)))

  /* ---------------------------------------------------------------- */
  /* Providers                                                         */
  /* ---------------------------------------------------------------- */

  function providerConfig(id: string): ResolvedConnectProvider | undefined {
    return config.providers.find((provider) => provider.id === id)
  }

  function runtimeFor(id: string): ProviderRuntime | undefined {
    const entry = providerConfig(id)
    if (!entry) return undefined
    return entry.custom
      ? customProvider(id, entry.custom)
      : BUILTIN_PROVIDERS[id as keyof typeof BUILTIN_PROVIDERS]
  }

  function credentialsFor(entry: ResolvedConnectProvider): {
    credentials: ProviderCredentials
    missing: string[]
  } {
    const clientId = readEnv(entry.clientIdEnv, env) ?? ''
    const clientSecret = readEnv(entry.clientSecretEnv, env) ?? ''
    const extra: Record<string, string> = {}
    const missing: string[] = []
    if (!clientId) missing.push(entry.clientIdEnv)
    if (!clientSecret) missing.push(entry.clientSecretEnv)
    const runtime = runtimeFor(entry.id)
    for (const item of entry.extraEnv) {
      const value = readEnv(item.env, env)
      if (value) extra[item.key] = value
      else if (!item.optional || runtime?.requiredExtra?.includes(item.key)) missing.push(item.env)
    }
    return { credentials: { clientId, clientSecret, extra, options: entry.options }, missing }
  }

  function configuredProvider(id: string): {
    entry: ResolvedConnectProvider
    runtime: ProviderRuntime
    credentials: ProviderCredentials
  } {
    const entry = providerConfig(id)
    const runtime = runtimeFor(id)
    if (!entry || !runtime) {
      throw new ConnectError(`${id} is not a provider this app connects to.`, 404)
    }
    const { credentials, missing } = credentialsFor(entry)
    if (missing.length > 0) {
      throw new ConnectError(
        `${entry.label} is not set up on this deployment yet (missing ${missing.join(', ')}).`,
        503,
        'not_configured',
      )
    }
    return { entry, runtime, credentials }
  }

  function providers(): ProviderSummary[] {
    const list: ProviderSummary[] = config.providers.map((entry) => {
      const { missing } = credentialsFor(entry)
      return {
        id: entry.id,
        label: entry.label,
        kind: 'oauth',
        configured: missing.length === 0,
        missing,
        allow: entry.allow,
        scopes: entry.scopes,
        startFields: entry.startFields,
        webhooks: Boolean(runtimeFor(entry.id)?.webhook),
      }
    })
    if (config.mcp) {
      list.push({
        id: MCP_PROVIDER_ID,
        label: 'MCP server',
        kind: 'mcp',
        configured: true,
        missing: [],
        allow: ['user', 'workspace'],
        scopes: [],
        startFields: [
          { key: 'server', label: 'Server URL', placeholder: 'https://mcp.example.com/mcp' },
        ],
        webhooks: false,
      })
    }
    return list
  }

  /* ---------------------------------------------------------------- */
  /* Policy                                                            */
  /* ---------------------------------------------------------------- */

  function sameSpace(row: ConnectionRow, actor: ConnectActor): boolean {
    return (row.organizationId ?? null) === actor.organizationId
  }

  function isMember(actor: ConnectActor): boolean {
    return actor.organizationId !== null && actor.role !== ''
  }

  function canSee(row: ConnectionRow, actor: ConnectActor): boolean {
    if (!sameSpace(row, actor)) return false
    if (row.scope === 'user') return row.userId === actor.userId
    return isMember(actor)
  }

  function canManage(row: ConnectionRow, actor: ConnectActor): boolean {
    if (!canSee(row, actor)) return false
    if (row.scope === 'user') return true
    return hasRole(actor.role, config.managerRoles)
  }

  function assertCanCreate(
    actor: ConnectActor,
    scope: ConnectionScope,
    allow: readonly ConnectionScope[],
  ) {
    if (!allow.includes(scope)) {
      throw new ConnectError(
        scope === 'workspace'
          ? 'This provider connects for one person only.'
          : 'This provider is connected for the whole workspace by an admin.',
        400,
      )
    }
    if (scope === 'workspace') {
      if (actor.organizationId === null) {
        throw new ConnectError('Switch to an organization to add a workspace connection.', 400)
      }
      if (!hasRole(actor.role, config.managerRoles)) {
        throw new ConnectError('Only organization admins can add workspace connections.', 403)
      }
    }
  }

  function summarize(row: ConnectionRow, actor: ConnectActor | null): ConnectionSummary {
    const metadata = parseMetadata(row)
    const targets = Array.isArray(metadata.targets)
      ? (metadata.targets as ConnectTarget[])
      : undefined
    return {
      id: row.id,
      uid: row.uid,
      provider: row.provider,
      kind: row.kind as ConnectionKind,
      scope: row.scope as ConnectionScope,
      organizationId: row.organizationId ?? null,
      userId: row.userId ?? null,
      status: row.status as ConnectionStatus,
      statusMessage: row.statusMessage,
      label: row.label,
      account: { id: row.accountId, name: row.accountName, url: row.accountUrl },
      scopes: row.scopes ? row.scopes.split(/[ ,]+/).filter(Boolean) : [],
      expiresAt: row.expiresAt ?? null,
      ...(row.status === 'pending' && targets ? { targets } : {}),
      ...(row.kind === 'mcp' && typeof metadata.server === 'string'
        ? { server: metadata.server }
        : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastUsedAt: row.lastUsedAt ?? null,
      mine: actor !== null && row.userId === actor.userId,
      canManage: actor !== null && canManage(row, actor),
    }
  }

  async function visibleRow(actor: ConnectActor, id: number): Promise<ConnectionRow> {
    const row = Number.isSafeInteger(id) && id > 0 ? await (await store()).find(id) : undefined
    if (!row || !canSee(row, actor)) throw new ConnectError('Connection not found.', 404)
    return row
  }

  async function manageableRow(actor: ConnectActor, id: number): Promise<ConnectionRow> {
    const row = await visibleRow(actor, id)
    if (!canManage(row, actor)) {
      throw new ConnectError('Only organization admins can change this connection.', 403)
    }
    return row
  }

  /* ---------------------------------------------------------------- */
  /* Origins                                                           */
  /* ---------------------------------------------------------------- */

  /** The canonical app origin: the configured auth URL, else the request's own. */
  function originOf(request: Request): string {
    const configured = base.auth ? readEnv(base.auth.baseUrlEnv, env) : undefined
    if (configured && URL.canParse(configured)) return new URL(configured).origin
    return new URL(request.url).origin
  }

  function callbackUrl(origin: string, provider: string): string {
    return connectCallbackUrl(origin, config.basePath, provider)
  }

  /** A CIMD client: its client_id is the URL its metadata document is served from. */
  function metadataClient(origin: string): McpClient {
    return {
      clientId: `${origin}${config.basePath}/mcp/client.json`,
      clientSecret: '',
      authMethod: 'none',
    }
  }

  function withQuery(returnTo: string, params: Record<string, string>): string {
    const url = new URL(returnTo, 'http://placeholder')
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return `${url.pathname}${url.search}${url.hash}`
  }

  /* ---------------------------------------------------------------- */
  /* OAuth flow                                                        */
  /* ---------------------------------------------------------------- */

  async function start(
    actor: ConnectActor,
    request: Request,
    input: {
      provider: string
      scope?: ConnectionScope
      scopes?: readonly string[]
      returnTo?: string
      fields?: Record<string, string>
      label?: string
      /** Re-authorize this connection instead of adding a new one. */
      connection?: number
    },
  ): Promise<{ url: string }> {
    if (input.provider === MCP_PROVIDER_ID) {
      return startMcp(actor, request, {
        server: input.fields?.server ?? '',
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.returnTo ? { returnTo: input.returnTo } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.connection ? { connection: input.connection } : {}),
      })
    }
    const { entry, runtime, credentials } = configuredProvider(input.provider)
    let scope = input.scope ?? entry.allow[0]!
    let reconnect: ConnectionRow | undefined
    if (input.connection) {
      reconnect = await manageableRow(actor, input.connection)
      if (reconnect.provider !== entry.id) {
        throw new ConnectError('That connection belongs to another provider.', 400)
      }
      scope = reconnect.scope as ConnectionScope
    } else {
      assertCanCreate(actor, scope, entry.allow)
    }
    const requested = input.scopes?.length ? input.scopes : entry.scopes
    const unknown = requested.filter((value) => !entry.scopes.includes(value))
    if (unknown.length > 0) {
      throw new ConnectError(
        `This app does not request ${unknown.join(', ')} from ${entry.label}.`,
        400,
      )
    }
    const scopes = [...new Set([...(runtime.baseScopes ?? []), ...requested])]
    const fields: Record<string, string> = {}
    for (const field of entry.startFields) {
      const value = input.fields?.[field.key]?.trim()
      if (!value) throw new ConnectError(`Enter ${field.label.toLowerCase()}.`, 400)
      fields[field.key] = value.slice(0, 200)
    }
    const origin = originOf(request)
    const redirectUri = callbackUrl(origin, entry.id)
    const pkce = runtime.pkce ? await pkcePair() : undefined
    const state = await encodeState(await keyring(), {
      provider: entry.id,
      scope,
      organizationId: actor.organizationId,
      userId: actor.userId,
      returnTo: safeReturnTo(input.returnTo),
      redirectUri,
      scopes,
      ...(pkce ? { verifier: pkce.verifier } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(reconnect ? { connection: reconnect.uid } : {}),
      ...(input.label ? { label: input.label.slice(0, MAX_LABEL_LENGTH) } : {}),
    })
    try {
      return {
        url: runtime.authorizeUrl({
          credentials,
          redirectUri,
          state,
          scopes,
          ...(pkce ? { challenge: pkce.challenge } : {}),
          scope,
          fields,
        }),
      }
    } catch (cause) {
      throw new ConnectError(
        cause instanceof Error ? cause.message : 'Could not start the connection.',
        400,
      )
    }
  }

  /**
   * The vendor sent the browser back. Returns where to send it next: the app
   * page that started the flow, or a vendor page (GitHub's install screen).
   * Errors are reported on the return URL, never as a dead-end page.
   */
  async function complete(
    actor: ConnectActor | null,
    request: Request,
    provider: string,
  ): Promise<{ redirect: string }> {
    const query = new URL(request.url).searchParams
    const rawState = query.get('state') ?? ''
    let state: FlowState | null = null
    if (actor && rawState) {
      state = await decodeState(await keyring(), rawState, { provider, userId: actor.userId })
    }
    const fail = (message: string) => ({
      redirect: withQuery(state?.returnTo ?? '/', {
        connect_error: message.slice(0, MAX_MESSAGE_LENGTH),
      }),
    })
    if (!actor) return fail('Sign in, then connect the account again.')
    if (!state) {
      return fail('This connection attempt expired or was started in another session. Try again.')
    }
    const vendorError = query.get('error')
    if (vendorError) {
      return fail(
        vendorError === 'access_denied'
          ? 'The connection was cancelled.'
          : `The provider refused: ${query.get('error_description') ?? vendorError}`,
      )
    }

    // The flow may have started in another organization than the one now active.
    const flowActor = await actorFor({ userId: actor.userId, organizationId: state.organizationId })
    if (!flowActor) {
      return fail('You are no longer a member of the workspace this connection was for.')
    }

    try {
      const row =
        provider === MCP_PROVIDER_ID
          ? await completeMcp(flowActor, state, query)
          : await completeOAuth(flowActor, state, provider, query, rawState)
      if ('redirect' in row) return row
      return {
        redirect: withQuery(state.returnTo, {
          connect: row.status === 'pending' ? 'choose' : 'connected',
          connection: String(row.id),
        }),
      }
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : 'The connection could not be completed.')
    }
  }

  async function completeOAuth(
    actor: ConnectActor,
    state: FlowState,
    providerId: string,
    query: URLSearchParams,
    rawState: string,
  ): Promise<ConnectionRow | { redirect: string }> {
    const { entry, runtime, credentials } = configuredProvider(providerId)
    const fields = state.fields ?? {}
    if (runtime.verifyCallback) {
      const problem = await runtime.verifyCallback({ query, credentials, fields })
      if (problem) throw new ConnectError(problem, 400)
    }
    const code = query.get('code')
    if (!code) throw new ConnectError(`${entry.label} sent no authorization code.`, 400)
    const tokens = await runtime.exchange({
      credentials,
      code,
      redirectUri: state.redirectUri,
      ...(state.verifier ? { verifier: state.verifier } : {}),
      query,
      fields,
      scope: state.scope,
      fetch: fetcher,
    })
    const context = { credentials, tokens, metadata: {}, scope: state.scope, fetch: fetcher }
    const next = await runtime.continueAuthorization?.({ ...context, query, state: rawState })
    if (next) return { redirect: next }
    const identity = await runtime.identify({ ...context, query, fields })
    const pending = (identity.targets?.length ?? 0) > 0
    if (
      state.scope === 'workspace' &&
      identity.targets &&
      identity.targets.length === 0 &&
      !identity.account.id
    ) {
      throw new ConnectError(
        `${entry.label} has nothing this account can connect for the workspace.`,
        400,
      )
    }
    return persist(actor, state, {
      provider: entry.id,
      kind: 'oauth',
      tokens,
      account: identity.account,
      metadata: { ...(identity.metadata ?? {}), ...(pending ? { targets: identity.targets } : {}) },
      status: pending ? 'pending' : 'active',
    })
  }

  async function persist(
    actor: ConnectActor,
    state: FlowState,
    input: {
      provider: string
      kind: ConnectionKind
      tokens: TokenSet
      account: { id: string; name: string; url?: string }
      metadata: Record<string, unknown>
      status: ConnectionStatus
    },
  ): Promise<ConnectionRow> {
    const db = await store()
    const secrets: StoredSecrets = {
      accessToken: input.tokens.accessToken,
      ...(input.tokens.refreshToken ? { refreshToken: input.tokens.refreshToken } : {}),
      ...(input.tokens.tokenType ? { tokenType: input.tokens.tokenType } : {}),
    }
    const scopes = input.tokens.scope ?? state.scopes.join(' ')
    let existing = state.connection ? await db.findByUid(state.connection) : undefined
    if (state.connection && (!existing || !canManage(existing, actor))) {
      throw new ConnectError('The connection being re-authorized no longer exists.', 404)
    }
    if (
      existing &&
      existing.accountId &&
      input.status === 'active' &&
      existing.accountId !== input.account.id
    ) {
      throw new ConnectError(
        `You authorized ${input.account.name}, but this connection is for ${existing.accountName}. Sign in to that account and try again.`,
        409,
      )
    }
    existing ??=
      input.status === 'active'
        ? await db.sameAccount({
            provider: input.provider,
            scope: state.scope,
            organizationId: state.organizationId,
            userId: actor.userId,
            accountId: input.account.id,
          })
        : undefined
    const fields = {
      status: input.status,
      statusMessage: '',
      accountId: input.account.id,
      accountName: input.account.name,
      accountUrl: input.account.url ?? '',
      scopes,
      metadata: JSON.stringify(input.metadata),
      refreshLeaseUntil: null,
      ...tokenColumns(input.tokens),
    }
    if (existing) {
      return swapOrConflict(db, existing, {
        ...fields,
        secrets: await db.sealSecrets(existing.uid, secrets),
        ...(state.label ? { label: state.label } : {}),
      })
    }
    // Roles can change between starting and finishing a flow.
    assertCanCreate(actor, state.scope, [state.scope])
    const uid = randomId('con')
    return db.insert({
      uid,
      provider: input.provider,
      kind: input.kind,
      scope: state.scope,
      organizationId: state.organizationId,
      userId: actor.userId,
      label: state.label ?? '',
      secrets: await db.sealSecrets(uid, secrets),
      ...fields,
    })
  }

  async function selectTarget(
    actor: ConnectActor,
    id: number,
    targetId: string,
  ): Promise<ConnectionSummary> {
    const db = await store()
    const row = await manageableRow(actor, id)
    if (row.status !== 'pending') throw new ConnectError('This connection is already set up.', 409)
    const metadata = parseMetadata(row)
    const targets = Array.isArray(metadata.targets) ? (metadata.targets as ConnectTarget[]) : []
    const target = targets.find((entry) => entry.id === targetId)
    if (!target) throw new ConnectError('Choose one of the listed options.', 400)
    const { runtime, credentials } = configuredProvider(row.provider)
    if (!runtime.selectTarget) throw new ConnectError('This provider has nothing to choose.', 400)
    const { secrets } = await db.openSecrets(row)
    const { targets: _targets, ...rest } = metadata
    const chosen = await runtime.selectTarget({
      credentials,
      tokens: tokensOf(row, secrets),
      metadata: rest,
      scope: row.scope as ConnectionScope,
      fetch: fetcher,
      target,
    })
    const duplicate = await db.sameAccount({
      provider: row.provider,
      scope: row.scope as ConnectionScope,
      organizationId: row.organizationId ?? null,
      userId: actor.userId,
      accountId: chosen.account.id,
    })
    if (duplicate && duplicate.id !== row.id) {
      await db.remove([row.id])
      throw new ConnectError(`${chosen.account.name} is already connected.`, 409)
    }
    const updated = await swapOrConflict(db, row, {
      status: 'active',
      accountId: chosen.account.id,
      accountName: chosen.account.name,
      accountUrl: chosen.account.url ?? '',
      metadata: JSON.stringify(chosen.metadata),
    })
    return summarize(updated, actor)
  }

  /** Write under the row's version, or tell the caller to retry. */
  async function swapOrConflict(
    db: ConnectStore,
    row: ConnectionRow,
    patch: Partial<ConnectionInsert>,
  ): Promise<ConnectionRow> {
    const updated = await db.swap(row, patch)
    if (!updated) throw new ConnectError('The connection changed while saving. Try again.', 409)
    return updated
  }

  /* ---------------------------------------------------------------- */
  /* MCP flow                                                          */
  /* ---------------------------------------------------------------- */

  function mcpOptions() {
    if (!config.mcp) throw new ConnectError('MCP connections are not enabled in this app.', 404)
    return config.mcp
  }

  function checkMcpEndpoint(url: string) {
    if (!URL.canParse(url)) throw new ProviderError('The MCP server advertised an invalid URL.')
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && !(development && isLoopbackHost(parsed.hostname))) {
      throw new ProviderError('The MCP server advertised an endpoint that is not https.')
    }
  }

  async function mcpClientFor(input: {
    issuer: string
    registrationEndpoint: string
    clientIdMetadata: boolean
    scopes: string[]
    origin: string
    redirectUri: string
  }): Promise<{ ref: string; client: McpClient }> {
    const options = mcpOptions()
    const { hostname, host } = new URL(input.origin)
    // A metadata-document client_id must be fetchable by the authorization server.
    if (
      input.clientIdMetadata &&
      input.origin.startsWith('https://') &&
      !isLoopbackHost(hostname)
    ) {
      return { ref: METADATA_CLIENT_REF, client: metadataClient(input.origin) }
    }
    const db = await store()
    const existing = await db.findClient(input.issuer, input.redirectUri)
    if (existing) return { ref: existing.uid, client: await storedClient(db, existing) }
    const registered = await registerMcpClient(fetcher, input, {
      clientName: options.clientName ?? host,
      redirectUri: input.redirectUri,
      clientUri: input.origin,
    })
    const row = await db.insertClient({
      uid: randomId('cli'),
      issuer: input.issuer,
      redirectUri: input.redirectUri,
      clientId: registered.clientId,
      clientSecret: registered.clientSecret,
      metadata: { authMethod: registered.authMethod },
    })
    return { ref: row.uid, client: registered }
  }

  async function clientByRef(ref: string, origin: string): Promise<McpClient> {
    if (ref === METADATA_CLIENT_REF) return metadataClient(origin)
    const db = await store()
    const row = await db.findClientByUid(ref)
    if (!row) {
      throw new ReauthorizeError('The MCP client registration is gone. Connect the server again.')
    }
    return storedClient(db, row)
  }

  async function storedClient(db: ConnectStore, row: ClientRow): Promise<McpClient> {
    const metadata = JSON.parse(row.metadata) as { authMethod?: string }
    return {
      clientId: row.clientId,
      clientSecret: await db.openClientSecret(row),
      authMethod: metadata.authMethod ?? 'none',
    }
  }

  async function startMcp(
    actor: ConnectActor,
    request: Request,
    input: {
      server: string
      scope?: ConnectionScope
      returnTo?: string
      label?: string
      connection?: number
    },
  ): Promise<{ url: string }> {
    const options = mcpOptions()
    let scope = input.scope ?? 'user'
    let reconnect: ConnectionRow | undefined
    let server = input.server
    if (input.connection) {
      reconnect = await manageableRow(actor, input.connection)
      if (reconnect.kind !== 'mcp') {
        throw new ConnectError('That connection is not an MCP server.', 400)
      }
      scope = reconnect.scope as ConnectionScope
      server = String(parseMetadata(reconnect).server ?? '')
    } else {
      assertCanCreate(actor, scope, ['user', 'workspace'])
    }
    const url = assertMcpUrl(server, {
      ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
      development,
    })
    const metadata = await discoverMcpServer(fetcher, url, checkMcpEndpoint)
    const origin = originOf(request)
    const redirectUri = callbackUrl(origin, MCP_PROVIDER_ID)
    const { ref, client } = await mcpClientFor({ ...metadata, origin, redirectUri })
    const pkce = await pkcePair()
    const state = await encodeState(await keyring(), {
      provider: MCP_PROVIDER_ID,
      scope,
      organizationId: actor.organizationId,
      userId: actor.userId,
      returnTo: safeReturnTo(input.returnTo),
      redirectUri,
      scopes: metadata.scopes,
      verifier: pkce.verifier,
      ...(reconnect ? { connection: reconnect.uid } : {}),
      ...(input.label ? { label: input.label.slice(0, MAX_LABEL_LENGTH) } : {}),
      mcp: {
        server: url.toString(),
        client: ref,
        resource: metadata.resource,
        issuer: metadata.issuer,
        tokenEndpoint: metadata.tokenEndpoint,
        revocationEndpoint: metadata.revocationEndpoint,
      },
    })
    return {
      url: mcpAuthorizeUrl(metadata, {
        clientId: client.clientId,
        redirectUri,
        state,
        challenge: pkce.challenge,
      }),
    }
  }

  async function completeMcp(
    actor: ConnectActor,
    state: FlowState,
    query: URLSearchParams,
  ): Promise<ConnectionRow> {
    const mcp = state.mcp
    const code = query.get('code')
    if (!mcp || !code) throw new ConnectError('The MCP server sent no authorization code.', 400)
    const origin = new URL(state.redirectUri).origin
    const client = await clientByRef(mcp.client, origin)
    const tokens = await mcpTokenRequest(fetcher, {
      tokenEndpoint: mcp.tokenEndpoint,
      resource: mcp.resource,
      client,
      params: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: state.redirectUri,
        code_verifier: state.verifier ?? '',
      },
    })
    // Prove the token works and learn the server's name before calling it connected.
    const session = new McpSession(fetcher, mcp.server, tokens.accessToken)
    await session.open()
    const tools = await listMcpTools(session)
    await session.close()
    const host = new URL(mcp.server).host
    return persist(actor, state, {
      provider: MCP_PROVIDER_ID,
      kind: 'mcp',
      tokens,
      account: { id: mcp.server, name: state.label || host, url: new URL(mcp.server).origin },
      metadata: {
        server: mcp.server,
        resource: mcp.resource,
        issuer: mcp.issuer,
        tokenEndpoint: mcp.tokenEndpoint,
        revocationEndpoint: mcp.revocationEndpoint,
        client: mcp.client,
        origin,
        toolCount: tools.length,
      },
      status: 'active',
    })
  }

  /* ---------------------------------------------------------------- */
  /* API keys                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Store an API key the app has already verified with the vendor. Server-side
   * only: the app knows how to check a Stripe key, Connect only seals it.
   */
  async function saveApiKey(
    actor: ConnectActor,
    input: {
      provider: string
      scope: ConnectionScope
      fields: Record<string, string>
      account: { id: string; name: string; url?: string }
      label?: string
      metadata?: Record<string, unknown>
      /** Replace the key on this connection. */
      connection?: number
    },
  ): Promise<ConnectionSummary> {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(input.provider) || input.provider === MCP_PROVIDER_ID) {
      throw new ConnectError('Use a provider id of 2-40 lowercase letters, digits and dashes.', 400)
    }
    if (JSON.stringify(input.fields).length > MAX_SECRET_BYTES) {
      throw new ConnectError('Those credentials are too large.', 400)
    }
    if (Object.values(input.fields).some((value) => typeof value !== 'string')) {
      throw new ConnectError('Credentials must be text.', 400)
    }
    const db = await store()
    const secrets: StoredSecrets = { fields: input.fields }
    const columns = {
      status: 'active',
      statusMessage: '',
      accountId: input.account.id.slice(0, 200),
      accountName: input.account.name.slice(0, 200),
      accountUrl: input.account.url ?? '',
      metadata: JSON.stringify(input.metadata ?? {}),
    } as const
    if (input.connection) {
      const row = await manageableRow(actor, input.connection)
      if (row.provider !== input.provider || row.kind !== 'api_key') {
        throw new ConnectError('That connection belongs to another provider.', 400)
      }
      const updated = await swapOrConflict(db, row, {
        ...columns,
        ...(input.label !== undefined ? { label: input.label.slice(0, MAX_LABEL_LENGTH) } : {}),
        secrets: await db.sealSecrets(row.uid, secrets),
      })
      return summarize(updated, actor)
    }
    assertCanCreate(actor, input.scope, ['user', 'workspace'])
    const uid = randomId('con')
    const row = await db.insert({
      uid,
      provider: input.provider,
      kind: 'api_key',
      scope: input.scope,
      organizationId: actor.organizationId,
      userId: actor.userId,
      label: (input.label ?? '').slice(0, MAX_LABEL_LENGTH),
      secrets: await db.sealSecrets(uid, secrets),
      ...columns,
    })
    return summarize(row, actor)
  }

  /* ---------------------------------------------------------------- */
  /* Using a connection                                                */
  /* ---------------------------------------------------------------- */

  function tokensOf(row: ConnectionRow, secrets: StoredSecrets): TokenSet {
    return {
      accessToken: secrets.accessToken ?? '',
      ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      ...(secrets.tokenType ? { tokenType: secrets.tokenType } : {}),
    }
  }

  async function markError(row: ConnectionRow, message: string) {
    const db = await store()
    await db.update(row.id, {
      status: 'error',
      statusMessage: message.slice(0, MAX_MESSAGE_LENGTH),
      refreshLeaseUntil: null,
    })
  }

  async function refreshTokens(row: ConnectionRow, tokens: TokenSet): Promise<TokenSet> {
    const metadata = parseMetadata(row)
    if (row.kind === 'mcp') {
      const next = await mcpTokenRequest(fetcher, {
        tokenEndpoint: String(metadata.tokenEndpoint ?? ''),
        resource: String(metadata.resource ?? ''),
        client: await clientByRef(String(metadata.client ?? ''), String(metadata.origin ?? '')),
        params: { grant_type: 'refresh_token', refresh_token: tokens.refreshToken ?? '' },
      })
      return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken! }
    }
    const { runtime, credentials } = configuredProvider(row.provider)
    if (!runtime.refresh) {
      throw new ReauthorizeError(
        `${runtime.label} tokens cannot be refreshed. Reconnect the account.`,
      )
    }
    return runtime.refresh({
      credentials,
      tokens,
      metadata,
      scope: row.scope as ConnectionScope,
      fetch: fetcher,
    })
  }

  /**
   * Refresh under the lease. Exactly one caller talks to the vendor; the rest
   * wait for its new tokens, so a rotating refresh token is spent once.
   */
  async function refreshRow(row: ConnectionRow): Promise<{ row: ConnectionRow; tokens: TokenSet }> {
    const db = await store()
    const spent = (await db.openSecrets(row)).secrets.accessToken
    let current = row
    const deadline = Date.now() + LEASE_WAIT_MS
    while (!(await db.lease(current, LEASE_MS))) {
      await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS))
      const latest = await db.find(current.id)
      if (!latest) throw new ConnectError('Connection not found.', 404)
      if (latest.version !== current.version) {
        // A new version is not always new tokens: a re-seal or webhook secret bumps it too.
        const { secrets } = await db.openSecrets(latest)
        if (secrets.accessToken !== spent) return { row: latest, tokens: tokensOf(latest, secrets) }
      }
      current = latest
      if (Date.now() > deadline) {
        throw new ConnectError('Refreshing this connection is taking too long. Try again.', 503)
      }
    }
    const { secrets } = await db.openSecrets(current)
    const tokens = tokensOf(current, secrets)
    if (!tokens.refreshToken) {
      await markError(
        current,
        'The access token expired and the provider gave no refresh token. Reconnect the account.',
      )
      throw new ConnectError('This connection expired. Reconnect the account.', 401, 'reauthorize')
    }
    try {
      const next = await refreshTokens(current, tokens)
      const updated = await db.swap(current, {
        secrets: await db.sealSecrets(current.uid, {
          ...secrets,
          accessToken: next.accessToken,
          ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}),
          ...(next.tokenType ? { tokenType: next.tokenType } : {}),
        }),
        ...tokenColumns(next),
        ...(next.scope ? { scopes: next.scope } : {}),
        status: 'active',
        statusMessage: '',
        refreshLeaseUntil: null,
      })
      if (!updated) {
        throw new ConnectError('The connection changed while refreshing. Try again.', 409)
      }
      return { row: updated, tokens: { ...tokens, ...next } }
    } catch (cause) {
      if (cause instanceof ReauthorizeError) {
        await markError(current, `${cause.message} Reconnect the account.`)
        throw new ConnectError(
          'This connection was revoked or expired. Reconnect the account.',
          401,
          'reauthorize',
        )
      }
      await db.release(current.id)
      throw cause
    }
  }

  const minted = new Map<string, TokenSet>()

  /**
   * A usable credential for a run acting as `actor`. Refreshes when the token
   * is near expiry, mints installation/bot tokens where the provider uses them,
   * and enforces the policy on every call.
   */
  async function access(
    actor: ConnectActor,
    id: number,
    options: { force?: boolean } = {},
  ): Promise<ConnectAccess> {
    const db = await store()
    let row = await visibleRow(actor, id)
    if (row.status === 'pending') {
      throw new ConnectError('Finish setting up this connection first.', 409)
    }
    if (row.status !== 'active') {
      throw new ConnectError(
        row.statusMessage || 'This connection needs attention. Reconnect the account.',
        401,
        'reauthorize',
      )
    }
    const opened = await db.openSecrets(row)
    if (opened.stale) row = (await db.reseal(row)) ?? row
    let tokens = tokensOf(row, opened.secrets)
    const metadata = parseMetadata(row)
    if (row.kind === 'api_key') {
      touch(row)
      return {
        connection: summarize(row, actor),
        accessToken: opened.secrets.fields?.token ?? opened.secrets.fields?.apiKey ?? '',
        tokenType: 'Bearer',
        expiresAt: null,
        fields: opened.secrets.fields ?? {},
        metadata,
      }
    }
    if (row.kind === 'oauth') {
      const { runtime, credentials } = configuredProvider(row.provider)
      if (runtime.mint) {
        const cached = minted.get(row.uid)
        const fresh =
          cached && (!cached.expiresAt || cached.expiresAt - Date.now() > REFRESH_SKEW_MS)
        const token =
          fresh && !options.force
            ? cached
            : await runtime.mint({
                credentials,
                tokens,
                metadata,
                scope: row.scope as ConnectionScope,
                fetch: fetcher,
              })
        if (token) {
          minted.set(row.uid, token)
          touch(row)
          return {
            connection: summarize(row, actor),
            accessToken: token.accessToken,
            tokenType: token.tokenType ?? 'Bearer',
            expiresAt: token.expiresAt ?? null,
            fields: {},
            metadata,
          }
        }
      }
    }
    const expiring = row.expiresAt !== null && row.expiresAt - Date.now() < REFRESH_SKEW_MS
    if (expiring || options.force) {
      ;({ row, tokens } = await refreshRow(row))
    }
    touch(row)
    return {
      connection: summarize(row, actor),
      accessToken: tokens.accessToken,
      tokenType:
        tokens.tokenType && tokens.tokenType.toLowerCase() !== 'bearer'
          ? tokens.tokenType
          : 'Bearer',
      expiresAt: row.expiresAt ?? null,
      fields: {},
      metadata,
    }
  }

  function touch(row: ConnectionRow) {
    if (row.lastUsedAt && Date.now() - row.lastUsedAt < LAST_USED_GRANULARITY_MS) return
    void store()
      .then((db) => db.update(row.id, { lastUsedAt: Date.now() }))
      .catch(() => {})
  }

  /**
   * Use an MCP connection, or an OAuth account at an endpoint explicitly listed
   * in that provider's mcpServers. Refreshes once when the server rejects a token.
   */
  function mcp(
    actor: ConnectActor,
    id: number,
    options: { server?: string; signal?: AbortSignal } = {},
  ) {
    async function withSession<T>(work: (session: McpSession) => Promise<T>): Promise<T> {
      options.signal?.throwIfAborted()
      for (let attempt = 0; attempt < 2; attempt++) {
        const credential = await access(actor, id, { force: attempt > 0 })
        options.signal?.throwIfAborted()
        let server = String(credential.metadata.server ?? '')
        if (credential.connection.kind === 'oauth') {
          if (!options.server || !URL.canParse(options.server)) {
            throw new ConnectError(
              'Choose a configured MCP endpoint for this OAuth connection.',
              400,
            )
          }
          server = new URL(options.server).href
          const allowedServers = providerConfig(credential.connection.provider)?.mcpServers ?? []
          if (!allowedServers.includes(server)) {
            throw new ConnectError(
              'This provider does not allow its tokens at that MCP endpoint.',
              403,
            )
          }
        } else if (credential.connection.kind !== 'mcp') {
          throw new ConnectError('That connection is not an MCP server or OAuth account.', 400)
        } else if (options.server && options.server !== server) {
          throw new ConnectError('The endpoint of an MCP connection cannot be overridden.', 403)
        }
        const session = new McpSession(fetcher, server, credential.accessToken, options.signal)
        try {
          await session.open()
          return await work(session)
        } catch (cause) {
          if (!(cause instanceof ReauthorizeError)) throw cause
          const isOAuthAccount = credential.connection.kind === 'oauth'
          // A service or scope rejection must not disable a grant used by other APIs.
          if (isOAuthAccount && cause.status === 403) {
            throw new ConnectError(
              'The MCP server denied access. Check OAuth scopes and service configuration.',
              403,
            )
          }
          if (attempt === 0) continue
          if (isOAuthAccount) {
            throw new ConnectError(
              'The MCP server rejected the refreshed OAuth token. Check its required scopes or reconnect the account.',
              401,
              'reauthorize',
            )
          }
          const row = await (await store()).find(id)
          if (row) await markError(row, 'The MCP server rejected the token. Reconnect the server.')
          throw new ConnectError(
            'The MCP server rejected the token. Reconnect the server.',
            401,
            'reauthorize',
          )
        } finally {
          await session.close()
        }
      }
      throw new ConnectError('The MCP server could not be reached.', 502)
    }
    return {
      listTools: (): Promise<McpTool[]> => withSession(listMcpTools),
      callTool: (
        name: string,
        args: Record<string, unknown>,
        timeoutMs?: number,
      ): Promise<McpCallResult> =>
        withSession((session) => callMcpTool(session, name, args, timeoutMs)),
    }
  }

  /* ---------------------------------------------------------------- */
  /* Management                                                        */
  /* ---------------------------------------------------------------- */

  async function list(
    actor: ConnectActor,
    filter: { provider?: string; kind?: ConnectionKind; scope?: ConnectionScope } = {},
  ): Promise<ConnectionSummary[]> {
    const db = await store()
    const c = db.connection
    const rows = await db.visible(
      actor,
      and(
        filter.provider ? eq(c.provider, filter.provider) : undefined,
        filter.kind ? eq(c.kind, filter.kind) : undefined,
        filter.scope ? eq(c.scope, filter.scope) : undefined,
      ),
    )
    return rows
      .filter((row) => row.scope === 'user' || isMember(actor))
      .map((row) => summarize(row, actor))
  }

  async function get(actor: ConnectActor, id: number): Promise<ConnectionSummary> {
    return summarize(await visibleRow(actor, id), actor)
  }

  async function rename(
    actor: ConnectActor,
    id: number,
    label: string,
  ): Promise<ConnectionSummary> {
    const db = await store()
    await manageableRow(actor, id)
    const updated = await db.update(id, { label: label.trim().slice(0, MAX_LABEL_LENGTH) })
    return summarize(updated!, actor)
  }

  /** Revoke at the vendor (best effort), then forget the row. */
  async function revokeRow(row: ConnectionRow): Promise<void> {
    const db = await store()
    try {
      const { secrets } = await db.openSecrets(row)
      const tokens = tokensOf(row, secrets)
      const metadata = parseMetadata(row)
      if (row.kind === 'mcp' && (tokens.refreshToken || tokens.accessToken)) {
        await mcpRevoke(fetcher, {
          revocationEndpoint: String(metadata.revocationEndpoint ?? ''),
          client: await clientByRef(String(metadata.client ?? ''), String(metadata.origin ?? '')),
          token: tokens.refreshToken ?? tokens.accessToken,
        })
      } else if (row.kind === 'oauth' && tokens.accessToken) {
        const runtime = runtimeFor(row.provider)
        const entry = providerConfig(row.provider)
        if (runtime?.revoke && entry) {
          const { credentials } = credentialsFor(entry)
          await runtime.revoke({
            credentials,
            tokens,
            metadata,
            scope: row.scope as ConnectionScope,
            fetch: fetcher,
          })
        }
      }
    } catch {
      // The local row is what grants access; a vendor that will not revoke is
      // not a reason to keep a live token around.
    }
    minted.delete(row.uid)
    await db.remove([row.id])
  }

  async function remove(actor: ConnectActor, id: number): Promise<void> {
    await revokeRow(await manageableRow(actor, id))
  }

  /** The per-connection secret an app-defined event sender signs with. Created on first request. */
  async function webhookSecret(actor: ConnectActor, id: number): Promise<string> {
    const db = await store()
    const row = await manageableRow(actor, id)
    return row.webhookSecret ? db.openWebhookSecret(row) : replaceWebhookSecret(db, row)
  }

  /** Replace the webhook secret; the old one stops working at once. */
  async function rotateWebhookSecret(actor: ConnectActor, id: number): Promise<string> {
    const db = await store()
    return replaceWebhookSecret(db, await manageableRow(actor, id))
  }

  async function replaceWebhookSecret(db: ConnectStore, row: ConnectionRow): Promise<string> {
    const secret = randomHex(32)
    await swapOrConflict(db, row, { webhookSecret: await db.sealWebhookSecret(row.uid, secret) })
    return secret
  }

  /* ---------------------------------------------------------------- */
  /* Webhooks                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * A vendor's app-level webhook (GitHub App, Slack, Linear, Shopify, …):
   * verify its signature, answer handshakes, and find every active connection
   * to the account it is about.
   */
  async function receiveWebhook(
    providerId: string,
    request: Request,
  ): Promise<{ response?: Response; deliveries: WebhookDelivery[] }> {
    const entry = providerConfig(providerId)
    const runtime = runtimeFor(providerId)
    if (!entry || !runtime?.webhook) throw new ConnectError('Unknown webhook.', 404)
    const { credentials } = credentialsFor(entry)
    const rawBody = await request.text()
    if (rawBody.length > MAX_EVENT_BYTES) throw new ConnectError('Webhook body too large.', 400)
    let payload: unknown = {}
    try {
      payload = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      payload = Object.fromEntries(new URLSearchParams(rawBody))
    }
    const verified = await runtime.webhook.verify({
      request,
      rawBody,
      payload,
      headers: request.headers,
      credentials,
    })
    if (!verified) throw new ConnectError('Webhook signature did not verify.', 401)
    const handshake = runtime.webhook.handshake?.({ payload, headers: request.headers })
    if (handshake) return { response: handshake, deliveries: [] }
    const accountId = runtime.webhook.accountId({ payload, headers: request.headers })
    if (!accountId) return { deliveries: [] }
    const { event, deliveryId } = runtime.webhook.describe({ payload, headers: request.headers })
    const db = await store()
    const c = db.connection
    const rows = await db.where(
      and(eq(c.provider, providerId), eq(c.accountId, accountId), eq(c.status, 'active')),
    )
    return {
      deliveries: rows.map((row) => ({
        provider: providerId,
        event,
        deliveryId,
        payload,
        connection: summarize(row, null),
      })),
    }
  }

  /**
   * An app-defined event for one connection, authenticated with that
   * connection's webhook secret: Connect's signature envelope, a GitHub
   * repository webhook signed with it, or the secret as a bearer token.
   */
  async function receiveConnectionEvent(
    uid: string,
    request: Request,
  ): Promise<{ connection: ConnectionSummary; rawBody: string; payload: unknown }> {
    const db = await store()
    const row = uid.startsWith('con_') ? await db.findByUid(uid) : undefined
    if (!row || row.status !== 'active' || !row.webhookSecret) {
      throw new ConnectError('Unknown event endpoint.', 404)
    }
    const secret = await db.openWebhookSecret(row)
    const rawBody = await request.text()
    if (rawBody.length > MAX_EVENT_BYTES) throw new ConnectError('Event body too large.', 400)
    const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    const verified =
      (await verifyConnectSignature(
        rawBody,
        secret,
        request.headers.get('x-cloudconfig-signature'),
      )) ||
      (await verifyHubSignature(rawBody, secret, request.headers.get('x-hub-signature-256'))) ||
      (bearer !== '' && timingSafeEqual(bearer, secret))
    if (!verified) throw new ConnectError('Event signature did not verify.', 401)
    let payload: unknown = {}
    try {
      payload = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      throw new ConnectError('Send the event as JSON.', 400)
    }
    return { connection: summarize(row, null), rawBody, payload }
  }

  async function dispatchWebhook(provider: string, request: Request): Promise<Response> {
    const result = await receiveWebhook(provider, request)
    if (result.response) return result.response
    if (!config.webhookTask && webhookHandlers.size === 0 && result.deliveries.length > 0) {
      console.warn(
        `[cloudconfig:connect] ${provider} webhook verified, but no handler is registered (onConnectWebhook).`,
      )
    }
    for (const delivery of result.deliveries) {
      if (config.webhookTask) {
        await enqueueConnectWebhook({ task: config.webhookTask, delivery, env })
      }
      for (const handler of webhookHandlers) await handler(delivery, { env, request })
    }
    return new Response(null, { status: 202 })
  }

  /* ---------------------------------------------------------------- */
  /* Membership                                                        */
  /* ---------------------------------------------------------------- */

  /** The actor for a job acting as `userId` in `organizationId` — null once they left. */
  async function actorFor(input: {
    userId: number
    organizationId: number | null
  }): Promise<ConnectActor | null> {
    return resolveActor(base, options.db, input)
  }

  /**
   * Someone left (or was removed from) an organization: delete their user
   * connections made there, at the vendor too. Workspace connections they
   * installed stay — they belong to the organization.
   */
  async function offboard(input: {
    userId: number
    organizationId: number | null
  }): Promise<number> {
    const db = await store()
    const c = db.connection
    const rows = await db.where(
      and(
        eq(c.scope, 'user'),
        eq(c.userId, input.userId),
        input.organizationId === null
          ? isNull(c.organizationId)
          : eq(c.organizationId, input.organizationId),
      ),
      1000,
    )
    for (const row of rows) await revokeRow(row)
    return rows.length
  }

  /** Current members of an organization — who a shared connection's events reach. */
  async function members(organizationId: number): Promise<{ userId: number; role: string }[]> {
    const table = base.models['member']?.table
    if (!table) return []
    const columns = getTableColumns(table) as Record<string, AnySQLiteColumn>
    const query = options.db
      .select({ userId: columns['userId']!, role: columns['role']! })
      .from(table)
      .where(eq(columns['organizationId']!, organizationId))
    return await (query as unknown as PromiseLike<{ userId: number; role: string }[]>)
  }

  /** An organization is being deleted: revoke everything made in it. */
  async function removeOrganization(organizationId: number): Promise<number> {
    const db = await store()
    const rows = await db.where(eq(db.connection.organizationId, organizationId), 5000)
    for (const row of rows) await revokeRow(row)
    return rows.length
  }

  /**
   * Housekeeping for a cron: refresh tokens about to lapse, re-seal under the
   * newest key, drop abandoned setups and connections whose owner is gone.
   */
  async function maintain(
    input: { limit?: number; afterId?: number; afterClientId?: number; signal?: AbortSignal } = {},
  ): Promise<ConnectMaintenanceResult> {
    const db = await store()
    const c = db.connection
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ConnectError('Maintenance limit must be between 1 and 500.')
    }
    for (const cursor of [input.afterId, input.afterClientId]) {
      if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
        throw new ConnectError('Use a valid maintenance cursor.')
      }
    }
    const now = Date.now()
    const result: ConnectMaintenanceResult = { refreshed: 0, failed: 0, resealed: 0, removed: 0 }

    async function maintainClients() {
      const prefix = sealPrefix(db.keyring.primary)
      const condition =
        input.afterClientId !== undefined
          ? gt(db.client.id, input.afterClientId)
          : and(
              ne(db.client.secret, ''),
              sql`substr(${db.client.secret}, 1, ${prefix.length}) <> ${prefix}`,
            )
      const rows = await db.clientsWhere(condition, limit)
      for (const row of rows) {
        input.signal?.throwIfAborted()
        try {
          if (await db.resealClient(row)) result.resealed++
        } catch {
          input.signal?.throwIfAborted()
          result.failed++
        }
      }
      if (input.afterClientId !== undefined) {
        result.nextClientCursor = rows.length === limit ? rows.at(-1)!.id : null
      }
    }

    async function refresh(row: ConnectionRow) {
      if (
        row.kind === 'api_key' ||
        row.status !== 'active' ||
        row.expiresAt === null ||
        row.expiresAt > now + MAINTENANCE_REFRESH_WINDOW_MS
      ) {
        return
      }
      try {
        const { secrets } = await db.openSecrets(row)
        if (!secrets.refreshToken) {
          if (row.expiresAt <= now) {
            await markError(row, 'The token expired. Reconnect the account.')
            result.failed++
          }
          return
        }
        await refreshRow(row)
        result.refreshed++
      } catch {
        input.signal?.throwIfAborted()
        result.failed++
      }
    }
    async function reseal(row: ConnectionRow) {
      try {
        if (await db.reseal(row)) result.resealed++
      } catch {
        input.signal?.throwIfAborted()
        result.failed++
      }
    }
    async function removeAbandoned(row: ConnectionRow) {
      if (
        (row.status === 'pending' && row.createdAt < now - PENDING_TTL_MS) ||
        (row.scope === 'user' && row.userId === null)
      ) {
        await revokeRow(row)
        result.removed++
      }
    }
    if (input.afterId !== undefined) {
      const rows = await db.where(gt(c.id, input.afterId), limit)
      for (const row of rows) {
        input.signal?.throwIfAborted()
        await refresh(row)
        const current = await db.find(row.id)
        if (!current) continue
        await reseal(current)
        await removeAbandoned(current)
      }
      result.nextCursor = rows.length === limit ? rows.at(-1)!.id : null
      await maintainClients()
      return result
    }
    const expiring = await db.where(
      and(
        eq(c.status, 'active'),
        isNotNull(c.expiresAt),
        lte(c.expiresAt, now + MAINTENANCE_REFRESH_WINDOW_MS),
      ),
      limit,
    )
    for (const row of expiring) {
      input.signal?.throwIfAborted()
      await refresh(row)
    }
    const prefix = sealPrefix(db.keyring.primary)
    const stale = await db.where(
      or(
        and(ne(c.secrets, ''), sql`substr(${c.secrets}, 1, ${prefix.length}) <> ${prefix}`),
        and(
          ne(c.webhookSecret, ''),
          sql`substr(${c.webhookSecret}, 1, ${prefix.length}) <> ${prefix}`,
        ),
      ),
      limit * 4,
    )
    for (const row of stale) {
      input.signal?.throwIfAborted()
      await reseal(row)
    }
    const abandoned = await db.where(
      or(
        and(eq(c.status, 'pending'), lt(c.createdAt, now - PENDING_TTL_MS)),
        and(eq(c.scope, 'user'), isNull(c.userId)),
      ),
      limit,
    )
    for (const row of abandoned) {
      input.signal?.throwIfAborted()
      await removeAbandoned(row)
    }
    await maintainClients()
    return result
  }

  /** The document a CIMD `client_id` URL serves. */
  function clientMetadata(request: Request) {
    const origin = originOf(request)
    return clientMetadataDocument({
      clientId: metadataClient(origin).clientId,
      clientName: config.mcp?.clientName ?? new URL(origin).host,
      redirectUri: callbackUrl(origin, MCP_PROVIDER_ID),
      clientUri: origin,
    })
  }

  return {
    config,
    providers,
    list,
    get,
    start,
    complete,
    selectTarget,
    rename,
    remove,
    saveApiKey,
    access,
    mcp,
    webhookSecret,
    rotateWebhookSecret,
    receiveWebhook,
    receiveConnectionEvent,
    dispatchWebhook,
    actorFor,
    members,
    offboard,
    removeOrganization,
    maintain,
    clientMetadata,
    summarize,
  }
}

/**
 * Resolve the actor a job runs as. Outside an organization that is just the
 * user; inside one it requires a current membership — a removed member's
 * automations stop being able to use anything at once.
 */
export async function resolveActor(
  base: CompiledBase,
  db: Db,
  input: { userId: number; organizationId: number | null },
): Promise<ConnectActor | null> {
  if (input.organizationId === null) return { userId: input.userId, organizationId: null, role: '' }
  const member = await membershipLookup(base)(db, input.userId, input.organizationId)
  return member
    ? { userId: input.userId, organizationId: input.organizationId, role: member.role }
    : null
}
