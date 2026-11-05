/**
 * Connect persistence: the only module that touches the connection tables.
 * Sealed columns are opened and written here, bound to the row's uid, so no
 * caller can forget the additional data or write a token in the clear.
 */
import { and, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm'
import type { ConnectionScope } from '../dsl/connect-config.js'
import type { CompiledBase } from '../server/compile/index.js'
import type { ConnectTables } from '../server/compile/connect-tables.js'
import type { Db } from '../server/driver.js'
import {
  aad,
  isSealed,
  reveal,
  revealJson,
  seal,
  sealJson,
  sealPrefix,
  type Keyring,
} from './crypto.js'
import type { TokenSet } from './http.js'
import type { ConnectionKind, ConnectionStatus } from '../shared/connect-types.js'

export type { ConnectionKind, ConnectionStatus }

export type ConnectionTable = ConnectTables['connectConnection']
export type ClientTable = ConnectTables['connectClient']
export type ConnectionRow = ConnectionTable['$inferSelect']
export type ConnectionInsert = ConnectionTable['$inferInsert']
export type ClientRow = ClientTable['$inferSelect']

/** What the sealed `secrets` column holds. */
export interface StoredSecrets {
  accessToken?: string
  refreshToken?: string
  tokenType?: string
  /** API-key connections: the fields the user entered. */
  fields?: Record<string, string>
}

export function tablesOf(base: CompiledBase): { connection: ConnectionTable; client: ClientTable } {
  const connection = base.models['connectConnection']?.table
  const client = base.models['connectClient']?.table
  if (!connection || !client) {
    throw new Error(
      'Connect is not configured. Add a connect block to cloud.config.ts and migrate.',
    )
  }
  return { connection: connection as ConnectionTable, client: client as ClientTable }
}

/** Drizzle's sync and async drivers both resolve query builders as promises. */
async function run<T>(query: unknown): Promise<T> {
  return (await (query as PromiseLike<T>)) as T
}

export class ConnectStore {
  readonly connection: ConnectionTable
  readonly client: ClientTable

  constructor(
    base: CompiledBase,
    private readonly db: Db,
    readonly keyring: Keyring,
  ) {
    const tables = tablesOf(base)
    this.connection = tables.connection
    this.client = tables.client
  }

  async find(id: number): Promise<ConnectionRow | undefined> {
    const rows = await run<ConnectionRow[]>(
      this.db.select().from(this.connection).where(eq(this.connection.id, id)).limit(1),
    )
    return rows[0]
  }

  async findByUid(uid: string): Promise<ConnectionRow | undefined> {
    const rows = await run<ConnectionRow[]>(
      this.db.select().from(this.connection).where(eq(this.connection.uid, uid)).limit(1),
    )
    return rows[0]
  }

  async where(condition: SQL | undefined, limit = 200): Promise<ConnectionRow[]> {
    return run<ConnectionRow[]>(
      this.db
        .select()
        .from(this.connection)
        .where(condition)
        .orderBy(this.connection.id)
        .limit(limit),
    )
  }

  /** Rows an actor may see: their own user connections here, and this organization's workspace ones. */
  async visible(
    actor: { userId: number; organizationId: number | null },
    extra?: SQL,
  ): Promise<ConnectionRow[]> {
    const c = this.connection
    const own = and(
      eq(c.scope, 'user'),
      eq(c.userId, actor.userId),
      actor.organizationId === null
        ? isNull(c.organizationId)
        : eq(c.organizationId, actor.organizationId),
    )
    const shared =
      actor.organizationId === null
        ? undefined
        : and(eq(c.scope, 'workspace'), eq(c.organizationId, actor.organizationId))
    const visible = shared ? or(own, shared) : own
    return this.where(extra ? and(visible, extra) : visible)
  }

  /** An existing connection to the same vendor account, so reconnecting updates instead of duplicating. */
  async sameAccount(input: {
    provider: string
    scope: ConnectionScope
    organizationId: number | null
    userId: number
    accountId: string
  }): Promise<ConnectionRow | undefined> {
    if (!input.accountId) return undefined
    const c = this.connection
    const rows = await this.where(
      and(
        eq(c.provider, input.provider),
        eq(c.scope, input.scope),
        eq(c.accountId, input.accountId),
        input.organizationId === null
          ? isNull(c.organizationId)
          : eq(c.organizationId, input.organizationId),
        input.scope === 'user' ? eq(c.userId, input.userId) : undefined,
      ),
      1,
    )
    return rows[0]
  }

  async insert(
    values: Omit<ConnectionInsert, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ConnectionRow> {
    const now = Date.now()
    const rows = await run<ConnectionRow[]>(
      this.db
        .insert(this.connection)
        .values({ ...values, createdAt: now, updatedAt: now })
        .returning(),
    )
    return rows[0]!
  }

  /** Unconditional update for columns that hold no tokens; leaves `version` alone. */
  async update(id: number, patch: Partial<ConnectionInsert>): Promise<ConnectionRow | undefined> {
    const rows = await run<ConnectionRow[]>(
      this.db
        .update(this.connection)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(this.connection.id, id))
        .returning(),
    )
    return rows[0]
  }

  /** Compare-and-swap on `version`: only one writer wins a token update. */
  async swap(
    row: ConnectionRow,
    patch: Partial<ConnectionInsert>,
  ): Promise<ConnectionRow | undefined> {
    const rows = await run<ConnectionRow[]>(
      this.db
        .update(this.connection)
        .set({ ...patch, version: row.version + 1, updatedAt: Date.now() })
        .where(and(eq(this.connection.id, row.id), eq(this.connection.version, row.version)))
        .returning(),
    )
    return rows[0]
  }

  /**
   * Take the refresh lease. Succeeds for exactly one caller while the lease is
   * free and nobody has written newer tokens, which is what keeps rotating
   * refresh tokens (Atlassian, Microsoft) from being spent twice.
   */
  async lease(row: ConnectionRow, ms: number): Promise<boolean> {
    const now = Date.now()
    const c = this.connection
    const rows = await run<{ id: number }[]>(
      this.db
        .update(c)
        .set({ refreshLeaseUntil: now + ms })
        .where(
          and(
            eq(c.id, row.id),
            eq(c.version, row.version),
            or(isNull(c.refreshLeaseUntil), lt(c.refreshLeaseUntil, now)),
          ),
        )
        .returning({ id: c.id }),
    )
    return rows.length === 1
  }

  async release(id: number): Promise<void> {
    await run(
      this.db
        .update(this.connection)
        .set({ refreshLeaseUntil: null })
        .where(eq(this.connection.id, id)),
    )
  }

  async remove(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    await run(this.db.delete(this.connection).where(inArray(this.connection.id, ids)))
  }

  /* ---------------------------------------------------------------- */
  /* Sealed columns                                                    */
  /* ---------------------------------------------------------------- */

  sealSecrets(uid: string, secrets: StoredSecrets): Promise<string> {
    return sealJson(this.keyring, secrets, aad('connectConnections', 'secrets', uid))
  }

  async openSecrets(row: ConnectionRow): Promise<{ secrets: StoredSecrets; stale: boolean }> {
    const { value, stale } = await revealJson<StoredSecrets>(
      this.keyring,
      row.secrets,
      aad('connectConnections', 'secrets', row.uid),
    )
    return { secrets: value ?? {}, stale }
  }

  sealWebhookSecret(uid: string, secret: string): Promise<string> {
    return seal(this.keyring, secret, aad('connectConnections', 'webhookSecret', uid))
  }

  async openWebhookSecret(row: ConnectionRow): Promise<string> {
    return (
      await reveal(
        this.keyring,
        row.webhookSecret,
        aad('connectConnections', 'webhookSecret', row.uid),
      )
    ).value
  }

  /**
   * Re-seal a row under the primary key (key rotation). Returns the new row,
   * or `undefined` when nothing was stale or another writer got there first.
   */
  async reseal(row: ConnectionRow): Promise<ConnectionRow | undefined> {
    const prefix = sealPrefix(this.keyring.primary)
    const needs = (value: string) => Boolean(value) && isSealed(value) && !value.startsWith(prefix)
    if (!needs(row.secrets) && !needs(row.webhookSecret)) return undefined
    const { secrets } = await this.openSecrets(row)
    const webhook = row.webhookSecret ? await this.openWebhookSecret(row) : ''
    return this.swap(row, {
      secrets: await this.sealSecrets(row.uid, secrets),
      webhookSecret: webhook ? await this.sealWebhookSecret(row.uid, webhook) : '',
    })
  }

  /* ---------------------------------------------------------------- */
  /* Registered OAuth clients (MCP)                                    */
  /* ---------------------------------------------------------------- */

  async findClient(issuer: string, redirectUri: string): Promise<ClientRow | undefined> {
    const rows = await run<ClientRow[]>(
      this.db
        .select()
        .from(this.client)
        .where(and(eq(this.client.issuer, issuer), eq(this.client.redirectUri, redirectUri)))
        .limit(1),
    )
    return rows[0]
  }

  async findClientByUid(uid: string): Promise<ClientRow | undefined> {
    const rows = await run<ClientRow[]>(
      this.db.select().from(this.client).where(eq(this.client.uid, uid)).limit(1),
    )
    return rows[0]
  }

  async clientsWhere(condition: SQL | undefined, limit: number): Promise<ClientRow[]> {
    return run<ClientRow[]>(
      this.db.select().from(this.client).where(condition).orderBy(this.client.id).limit(limit),
    )
  }

  async resealClient(row: ClientRow): Promise<boolean> {
    const opened = await reveal(this.keyring, row.secret, aad('connectClients', 'secret', row.uid))
    if (!opened.stale) return false
    const secret = await seal(this.keyring, opened.value, aad('connectClients', 'secret', row.uid))
    const changed = await run<{ id: number }[]>(
      this.db
        .update(this.client)
        .set({ secret })
        .where(and(eq(this.client.id, row.id), eq(this.client.secret, row.secret)))
        .returning({ id: this.client.id }),
    )
    return changed.length === 1
  }

  async insertClient(input: {
    uid: string
    issuer: string
    redirectUri: string
    clientId: string
    clientSecret: string
    metadata: Record<string, unknown>
  }): Promise<ClientRow> {
    const rows = await run<ClientRow[]>(
      this.db
        .insert(this.client)
        .values({
          uid: input.uid,
          issuer: input.issuer,
          redirectUri: input.redirectUri,
          clientId: input.clientId,
          secret: await seal(
            this.keyring,
            input.clientSecret,
            aad('connectClients', 'secret', input.uid),
          ),
          metadata: JSON.stringify(input.metadata),
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .returning(),
    )
    return rows[0] ?? (await this.findClient(input.issuer, input.redirectUri))!
  }

  async openClientSecret(row: ClientRow): Promise<string> {
    return (await reveal(this.keyring, row.secret, aad('connectClients', 'secret', row.uid))).value
  }
}

export function tokenColumns(
  tokens: TokenSet,
): Pick<ConnectionInsert, 'expiresAt' | 'refreshExpiresAt'> {
  return {
    expiresAt: tokens.expiresAt ?? null,
    refreshExpiresAt: tokens.refreshExpiresAt ?? null,
  }
}

export function parseMetadata(row: Pick<ConnectionRow, 'metadata'>): Record<string, unknown> {
  try {
    const value = JSON.parse(row.metadata) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
