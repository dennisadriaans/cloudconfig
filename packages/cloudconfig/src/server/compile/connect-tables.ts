/**
 * The tables CloudConfig Connect owns. Internal, like the auth tables: they
 * hold sealed vendor tokens, so no REST route, MCP tool or docs entry may ever
 * expose them. Connect's own routes return summaries only.
 *
 * Dates are epoch milliseconds in plain integer columns — the refresh lease
 * and compare-and-swap below are arithmetic on them.
 */
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
  type SQLiteTable,
} from 'drizzle-orm/sqlite-core'
import { getTableColumns } from 'drizzle-orm'
import { z } from 'zod'
import type { CompiledModel } from './index.js'

export const CONNECT_MODEL_NAMES = ['connectConnection', 'connectClient'] as const

function idOf(table: SQLiteTable | undefined): AnySQLiteColumn {
  const id = table ? getTableColumns(table)['id'] : undefined
  if (!id) throw new Error('connect: referenced table has no id column')
  return id
}

export function buildConnectTables(auth: { user: SQLiteTable; organization?: SQLiteTable }) {
  const connectConnection = sqliteTable(
    'connectConnections',
    {
      id: integer('id').primaryKey({ autoIncrement: true }),
      /** Random public id: the AAD every sealed column is bound to, and the webhook path segment. */
      uid: text('uid').notNull().unique(),
      provider: text('provider').notNull(),
      /** `oauth`, `mcp` or `api_key`. */
      kind: text('kind').notNull(),
      /** `user` (acts as the person who connected) or `workspace` (shared with an organization). */
      scope: text('scope').notNull(),
      organizationId: auth.organization
        ? integer('organization_id').references(() => idOf(auth.organization), {
            onDelete: 'cascade',
          })
        : integer('organization_id'),
      /**
       * Who connected it. A user connection is unusable once this is null; a
       * workspace connection outlives the person who installed it.
       */
      userId: integer('user_id').references(() => idOf(auth.user), { onDelete: 'set null' }),
      status: text('status').notNull().default('pending'),
      statusMessage: text('status_message').notNull().default(''),
      label: text('label').notNull().default(''),
      accountId: text('account_id').notNull().default(''),
      accountName: text('account_name').notNull().default(''),
      accountUrl: text('account_url').notNull().default(''),
      scopes: text('scopes').notNull().default(''),
      /** Sealed JSON: access/refresh tokens, API keys. */
      secrets: text('secrets').notNull().default(''),
      /** Sealed per-connection webhook signing secret. */
      webhookSecret: text('webhook_secret').notNull().default(''),
      /** Non-secret provider state: installation ids, site ids, MCP endpoints. */
      metadata: text('metadata').notNull().default('{}'),
      expiresAt: integer('expires_at'),
      refreshExpiresAt: integer('refresh_expires_at'),
      refreshLeaseUntil: integer('refresh_lease_until'),
      /** Bumped on every token write: the compare in compare-and-swap refreshes. */
      version: integer('version').notNull().default(0),
      lastUsedAt: integer('last_used_at'),
      createdAt: integer('created_at').notNull(),
      updatedAt: integer('updated_at').notNull(),
    },
    (table) => [
      index('connect_connections_owner_idx').on(table.organizationId, table.provider),
      index('connect_connections_user_idx').on(table.userId),
      index('connect_connections_account_idx').on(table.provider, table.accountId),
      index('connect_connections_expiry_idx').on(table.status, table.expiresAt),
    ],
  )

  const connectClient = sqliteTable(
    'connectClients',
    {
      id: integer('id').primaryKey({ autoIncrement: true }),
      uid: text('uid').notNull().unique(),
      /** Authorization server issuer the client is registered with. */
      issuer: text('issuer').notNull(),
      redirectUri: text('redirect_uri').notNull(),
      clientId: text('client_id').notNull(),
      /** Sealed client secret, empty for public clients. */
      secret: text('secret').notNull().default(''),
      metadata: text('metadata').notNull().default('{}'),
      createdAt: integer('created_at').notNull(),
    },
    (table) => [
      uniqueIndex('connect_clients_issuer_redirect_idx').on(table.issuer, table.redirectUri),
    ],
  )

  return { connectConnection, connectClient }
}

export type ConnectTables = ReturnType<typeof buildConnectTables>

/** Wrap the Connect tables as internal compiled models, for migrations only. */
export function compileConnectModels(auth: {
  user: SQLiteTable
  organization?: SQLiteTable
}): Record<string, CompiledModel> {
  const tables = buildConnectTables(auth)
  const empty = z.object({})
  const models: Record<string, CompiledModel> = {}
  for (const name of CONNECT_MODEL_NAMES) {
    models[name] = {
      name,
      namePlural: `${name}s`,
      label: name === 'connectClient' ? 'Connect client' : 'Connection',
      timestamps: false,
      internal: true,
      table: tables[name],
      fieldSpecs: {},
      relationships: [],
      create: empty,
      update: empty,
      model: { fields: {}, options: { timestamps: false } },
    }
  }
  return models
}
