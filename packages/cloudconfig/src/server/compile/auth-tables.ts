/**
 * The tables better-auth needs, authored as drizzle tables and compiled into
 * the same `CompiledBase` as every other model.
 *
 * Why they are models and not a separate schema: `cloudconfig db generate` diffs the
 * compiled tables, so putting the auth tables here means sign-in ships with the
 * project's normal migration flow instead of a second, hand-run one — and
 * `t.relation('user')` resolves like any other relation.
 *
 * They are marked `internal`, which keeps them out of REST routing, the MCP
 * tool list, the agent API and the docs page. That is the security property:
 * the `accounts` table holds provider refresh tokens, and no access rule
 * mistake — including `access: { default: 'allow' }` — can put it on the wire.
 *
 * Column names and types mirror better-auth's core schema exactly (its drizzle
 * adapter looks columns up by the JS key, so the keys are camelCase and dates
 * are `integer({ mode: 'timestamp' })`, which is what it reads and writes).
 */
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type SQLiteColumnBuilderBase,
  type SQLiteTable,
} from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import type { AnyField, FieldSpec } from '../../index.js'
import { ConfigError } from '../../shared/errors.js'
import { AUTH_MODEL_NAMES, ORGANIZATION_MODEL_NAMES } from '../../shared/auth-resolve.js'
import { pluralize } from '../../shared/pluralize.js'
import { buildColumn } from './columns.js'
import type { CompiledField, CompiledModel } from './index.js'

/** Columns better-auth owns on `user`; an extra field may not shadow one. */
const RESERVED_USER_FIELDS = new Set([
  'id',
  'name',
  'email',
  'emailVerified',
  'image',
  'createdAt',
  'updatedAt',
])

function timestamp(name: string) {
  return integer(name, { mode: 'timestamp' })
}

export interface AuthTables {
  user: SQLiteTable
  session: SQLiteTable
  account: SQLiteTable
  verification: SQLiteTable
  organization?: SQLiteTable
  member?: SQLiteTable
  invitation?: SQLiteTable
  twoFactor?: SQLiteTable
  passkey?: SQLiteTable
  scimToken?: SQLiteTable
  scimIdentity?: SQLiteTable
}

interface AuthTableOptions {
  admin?: boolean
  organizations?: boolean
  twoFactor?: boolean
  passkey?: boolean
  scim?: boolean
}

export function buildAuthTables(
  userFields: Record<string, AnyField>,
  options: AuthTableOptions = {},
): AuthTables {
  const admin = options.admin === true
  const organizations = options.organizations === true
  const extra: Record<string, SQLiteColumnBuilderBase> = {}
  for (const [name, field] of Object.entries(userFields)) {
    if (
      RESERVED_USER_FIELDS.has(name) ||
      (admin && ['role', 'banned', 'banReason', 'banExpires'].includes(name)) ||
      (options.twoFactor && ['twoFactorEnabled', 'twoFactorMethod'].includes(name))
    ) {
      throw new ConfigError(
        `auth.userFields: "${name}" is part of better-auth's own user schema and cannot be redefined.`,
      )
    }
    const spec = field[' spec']
    if (spec.relation) {
      throw new ConfigError(`auth.userFields: "${name}" cannot be a relation field.`)
    }
    // Sign-up through a social provider has no way to supply a value, so a
    // required column with no default would make every OAuth sign-up fail on
    // the insert. Catch it at compile time instead of at the first sign-in.
    if (spec.required && !spec.hasDefault) {
      throw new ConfigError(
        `auth.userFields: "${name}" is required but has no default. A user created by a social sign-in has no way to provide one — add .default(…) or drop .required().`,
      )
    }
    extra[name] = buildColumn(name, spec)
  }

  const user = sqliteTable(pluralize('user'), {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    ...(admin
      ? {
          role: text('role').default('user'),
          banned: integer('banned', { mode: 'boolean' }).default(false),
          banReason: text('ban_reason'),
          banExpires: timestamp('ban_expires'),
        }
      : {}),
    ...(options.twoFactor
      ? {
          twoFactorEnabled: integer('two_factor_enabled', { mode: 'boolean' }).default(false),
          twoFactorMethod: text('two_factor_method'),
        }
      : {}),
    ...extra,
  })

  const organization = organizations
    ? sqliteTable(pluralize('organization'), {
        id: integer('id').primaryKey({ autoIncrement: true }),
        name: text('name').notNull(),
        slug: text('slug').notNull().unique(),
        logo: text('logo'),
        metadata: text('metadata'),
        createdAt: timestamp('created_at').notNull(),
      })
    : undefined

  const session = sqliteTable(pluralize('session'), {
    id: integer('id').primaryKey({ autoIncrement: true }),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...(admin ? { impersonatedBy: text('impersonated_by') } : {}),
    ...(organization
      ? {
          activeOrganizationId: integer('active_organization_id').references(
            () => organization.id,
            { onDelete: 'set null' },
          ),
        }
      : {}),
    userId: integer('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  })

  const account = sqliteTable(pluralize('account'), {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  })

  const verification = sqliteTable(pluralize('verification'), {
    id: integer('id').primaryKey({ autoIncrement: true }),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  })

  const twoFactor = options.twoFactor
    ? sqliteTable(pluralize('twoFactor'), {
        id: integer('id').primaryKey({ autoIncrement: true }),
        userId: integer('user_id')
          .notNull()
          .references(() => user.id, { onDelete: 'cascade' }),
        secret: text('secret').notNull(),
        backupCodes: text('backup_codes').notNull(),
        verified: integer('verified', { mode: 'boolean' }).default(false),
        failedVerificationCount: integer('failed_verification_count').default(0),
        lockedUntil: timestamp('locked_until'),
      })
    : undefined

  const passkey = options.passkey
    ? sqliteTable(pluralize('passkey'), {
        id: integer('id').primaryKey({ autoIncrement: true }),
        name: text('name'),
        userId: integer('user_id')
          .notNull()
          .references(() => user.id, { onDelete: 'cascade' }),
        publicKey: text('public_key').notNull(),
        credentialID: text('credential_id').notNull().unique(),
        counter: integer('counter').notNull(),
        deviceType: text('device_type').notNull(),
        backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
        transports: text('transports'),
        createdAt: timestamp('created_at'),
        aaguid: text('aaguid'),
      })
    : undefined

  const member = organization
    ? sqliteTable(pluralize('member'), {
        id: integer('id').primaryKey({ autoIncrement: true }),
        organizationId: integer('organization_id')
          .notNull()
          .references(() => organization.id, { onDelete: 'cascade' }),
        userId: integer('user_id')
          .notNull()
          .references(() => user.id, { onDelete: 'cascade' }),
        role: text('role').notNull().default('member'),
        createdAt: timestamp('created_at').notNull(),
      })
    : undefined

  const invitation = organization
    ? sqliteTable(pluralize('invitation'), {
        id: integer('id').primaryKey({ autoIncrement: true }),
        organizationId: integer('organization_id')
          .notNull()
          .references(() => organization.id, { onDelete: 'cascade' }),
        email: text('email').notNull(),
        role: text('role'),
        status: text('status').notNull().default('pending'),
        expiresAt: timestamp('expires_at').notNull(),
        createdAt: timestamp('created_at').notNull(),
        inviterId: integer('inviter_id')
          .notNull()
          .references(() => user.id, { onDelete: 'cascade' }),
      })
    : undefined

  // CloudConfig's own SCIM tables: bearer tokens (hashed) per organization, and
  // the directory identities they provisioned. Epoch-millisecond integers.
  const scimToken =
    options.scim && organization
      ? sqliteTable(pluralize('scimToken'), {
          id: integer('id').primaryKey({ autoIncrement: true }),
          uid: text('uid').notNull().unique(),
          organizationId: integer('organization_id')
            .notNull()
            .references(() => organization.id, { onDelete: 'cascade' }),
          tokenHash: text('token_hash').notNull().unique(),
          label: text('label').notNull().default(''),
          createdBy: integer('created_by').references(() => user.id, { onDelete: 'set null' }),
          createdAt: integer('created_at').notNull(),
          expiresAt: integer('expires_at').notNull(),
          lastUsedAt: integer('last_used_at'),
          revokedAt: integer('revoked_at'),
        })
      : undefined
  const scimIdentity =
    options.scim && organization
      ? sqliteTable(
          pluralize('scimIdentity'),
          {
            id: integer('id').primaryKey({ autoIncrement: true }),
            uid: text('uid').notNull().unique(),
            organizationId: integer('organization_id')
              .notNull()
              .references(() => organization.id, { onDelete: 'cascade' }),
            userId: integer('user_id')
              .notNull()
              .references(() => user.id, { onDelete: 'cascade' }),
            userName: text('user_name').notNull(),
            externalId: text('external_id').notNull().default(''),
            displayName: text('display_name').notNull().default(''),
            active: integer('active', { mode: 'boolean' }).notNull().default(true),
            createdAt: integer('created_at').notNull(),
            updatedAt: integer('updated_at').notNull(),
          },
          (table) => [
            uniqueIndex('scim_identities_org_user_name_idx').on(
              table.organizationId,
              table.userName,
            ),
            index('scim_identities_org_external_idx').on(table.organizationId, table.externalId),
          ],
        )
      : undefined

  return {
    user,
    session,
    account,
    verification,
    ...(twoFactor ? { twoFactor } : {}),
    ...(passkey ? { passkey } : {}),
    ...(organization && member && invitation ? { organization, member, invitation } : {}),
    ...(scimToken && scimIdentity ? { scimToken, scimIdentity } : {}),
  }
}

function spec(kind: FieldSpec['kind'], required: boolean): FieldSpec {
  return { kind, required, unique: false, hasDefault: false }
}

/** The specs a relation projection and the docs would read off `user`. */
function userFieldSpecs(userFields: Record<string, AnyField>): Record<string, CompiledField> {
  const out: Record<string, CompiledField> = {
    name: { columnKey: 'name', spec: spec('text', true) },
    email: { columnKey: 'email', spec: spec('email', true) },
    emailVerified: { columnKey: 'emailVerified', spec: spec('boolean', true) },
    image: { columnKey: 'image', spec: spec('url', false) },
  }
  for (const [name, field] of Object.entries(userFields)) {
    out[name] = { columnKey: name, spec: field[' spec'] }
  }
  return out
}

/**
 * Wrap the auth tables as compiled models. `create`/`update` are empty schemas
 * on purpose: internal models are never routed, so the only consumers are the
 * relation resolver (which reads `table`) and the migration writer.
 */
export function compileAuthModels(
  userFields: Record<string, AnyField>,
  options: AuthTableOptions = {},
): Record<string, CompiledModel> {
  const tables = buildAuthTables(userFields, options)
  const empty = z.object({})
  const models: Record<string, CompiledModel> = {}

  const names = [
    ...AUTH_MODEL_NAMES,
    ...(options.organizations ? ORGANIZATION_MODEL_NAMES : []),
    ...(options.twoFactor ? (['twoFactor'] as const) : []),
    ...(options.passkey ? (['passkey'] as const) : []),
    ...(options.scim ? (['scimToken', 'scimIdentity'] as const) : []),
  ]
  for (const name of names) {
    const table = tables[name]
    if (!table) continue
    models[name] = {
      name,
      namePlural: pluralize(name),
      label: name === 'user' ? 'User' : `Auth ${name}`,
      timestamps: false,
      internal: true,
      table,
      fieldSpecs: name === 'user' ? userFieldSpecs(userFields) : {},
      relationships: [],
      create: empty,
      update: empty,
      model: { fields: {}, options: { timestamps: false } },
    }
  }
  return models
}
