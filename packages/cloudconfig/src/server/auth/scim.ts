/**
 * SCIM 2.0 directory provisioning, served by CloudConfig itself.
 *
 * Better Auth's SCIM plugin needs interactive database transactions, which D1
 * does not have, so provisioning is implemented here on plain statements. The
 * scope is what identity providers actually use for app access: the Users
 * resource. Each organization mints its own bearer tokens (stored as SHA-256
 * hashes), so a directory can only add or remove people in the organization
 * that issued its token.
 *
 * Provisioning adds a membership; deactivating or deleting removes it, which
 * ends the person's organization access on their next request, and deletes
 * their personal Connect connections made there.
 */
import { and, eq, getTableColumns, isNull, sql, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { base64UrlEncode, bytesToHex, sha256 } from '../../connect/crypto.js'
import type { ResolvedAuth } from '../../shared/auth-resolve.js'
import type { CompiledBase } from '../compile/index.js'
import type { Db } from '../driver.js'
import { readEnv } from './env.js'
import { membershipLookup } from './membership.js'
import type { AuthInstance } from './types.js'

type Ctx = { request: Request; env: Record<string, unknown> | undefined }
type Bindings = { Bindings: Record<string, unknown> }
type Columns = Record<string, AnySQLiteColumn>

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_PAGE = 100
const ADMIN_ROLES = ['owner', 'admin']
/** `lastUsedAt` is written at most this often, so a sync burst is not a write per request. */
const TOKEN_TOUCH_INTERVAL_MS = 5 * 60 * 1000

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await sha256(value))
}

function randomToken(prefix: string): string {
  return `${prefix}_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`
}

async function rows<T>(query: unknown): Promise<T[]> {
  return await (query as PromiseLike<T[]>)
}

/** The SCIM base URL identity providers call: the configured app origin, else the request's. */
function scimBaseUrl(auth: ResolvedAuth, c: Context<Bindings>): string {
  const configured = readEnv(auth.baseUrlEnv, c.env)
  const origin =
    configured && URL.canParse(configured) ? new URL(configured).origin : new URL(c.req.url).origin
  return `${origin}${auth.basePath}/scim/v2`
}

class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message)
  }
}

function tables(base: CompiledBase) {
  const get = (name: string) => {
    const table = base.models[name]?.table
    if (!table) {
      throw new Error(
        `[cloudconfig:auth] ${name} table missing — enable auth.organizations and auth.scim, then migrate.`,
      )
    }
    return { table, columns: getTableColumns(table) as Columns }
  }
  return {
    user: get('user'),
    member: get('member'),
    token: get('scimToken'),
    identity: get('scimIdentity'),
  }
}

interface IdentityRow {
  id: number
  uid: string
  organizationId: number
  userId: number
  userName: string
  externalId: string
  displayName: string
  active: boolean
  createdAt: number
  updatedAt: number
}

/** Remove someone from an organization; owners are never removed by a directory. */
async function removeMembership(
  base: CompiledBase,
  db: Db,
  env: Record<string, unknown> | undefined,
  userId: number,
  organizationId: number,
) {
  const { member } = tables(base)
  const removed = await rows<{ id: number }>(
    db
      .delete(member.table)
      .where(
        and(
          eq(member.columns['organizationId']!, organizationId),
          eq(member.columns['userId']!, userId),
          sql`${member.columns['role']!} not like '%owner%'`,
        ),
      )
      .returning({ id: member.columns['id']! }),
  )
  if (removed.length > 0 && base.connect) {
    try {
      const { createConnect } = await import('../../connect/runtime.js')
      await createConnect(base, { db, env }).offboard({ userId, organizationId })
    } catch (error) {
      console.warn(
        `[cloudconfig:scim] connection offboarding did not finish: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

async function ensureMembership(
  base: CompiledBase,
  db: Db,
  userId: number,
  organizationId: number,
  role: string,
) {
  const { member } = tables(base)
  const existing = await membershipLookup(base)(db, userId, organizationId)
  if (existing) return
  await rows(
    db.insert(member.table).values({
      organizationId,
      userId,
      role,
      createdAt: new Date(),
    } as Record<string, unknown>),
  )
}

/* ------------------------------------------------------------------ */
/* /scim/v2 — what identity providers call                             */
/* ------------------------------------------------------------------ */

export function scimApp(base: CompiledBase, auth: ResolvedAuth, dbFor: (ctx: Ctx) => Promise<Db>) {
  const app = new Hono<Bindings>()
  const scim = auth.scim!

  async function caller(c: Context<Bindings>) {
    const header = c.req.header('authorization') ?? ''
    const token = header.replace(/^Bearer\s+/i, '').trim()
    if (!token) throw new ScimError(401, 'Send the SCIM token as a bearer token.')
    const db = await dbFor({ request: c.req.raw, env: c.env })
    const { token: tokens } = tables(base)
    const hash = await sha256Hex(token)
    const [row] = await rows<{
      id: number
      organizationId: number
      expiresAt: number
      lastUsedAt: number | null
    }>(
      db
        .select({
          id: tokens.columns['id']!,
          organizationId: tokens.columns['organizationId']!,
          expiresAt: tokens.columns['expiresAt']!,
          lastUsedAt: tokens.columns['lastUsedAt']!,
        })
        .from(tokens.table)
        .where(and(eq(tokens.columns['tokenHash']!, hash), isNull(tokens.columns['revokedAt']!)))
        .limit(1),
    )
    if (!row || row.expiresAt < Date.now()) {
      throw new ScimError(401, 'This SCIM token is invalid, expired or revoked.')
    }
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt > TOKEN_TOUCH_INTERVAL_MS) {
      await rows(
        db
          .update(tokens.table)
          .set({ lastUsedAt: Date.now() })
          .where(eq(tokens.columns['id']!, row.id)),
      )
    }
    return { db, organizationId: row.organizationId }
  }

  async function emailOf(db: Db, userId: number): Promise<string> {
    const { user } = tables(base)
    const [row] = await rows<{ email: string }>(
      db
        .select({ email: user.columns['email']! })
        .from(user.table)
        .where(eq(user.columns['id']!, userId))
        .limit(1),
    )
    return row?.email ?? ''
  }

  async function resource(c: Context<Bindings>, db: Db, identity: IdentityRow) {
    const email = await emailOf(db, identity.userId)
    return {
      schemas: [USER_SCHEMA],
      id: identity.uid,
      ...(identity.externalId ? { externalId: identity.externalId } : {}),
      userName: identity.userName,
      displayName: identity.displayName || email,
      name: { formatted: identity.displayName || email },
      emails: email ? [{ value: email, primary: true, type: 'work' }] : [],
      active: identity.active,
      meta: {
        resourceType: 'User',
        created: new Date(identity.createdAt).toISOString(),
        lastModified: new Date(identity.updatedAt).toISOString(),
        location: `${scimBaseUrl(auth, c)}/Users/${identity.uid}`,
      },
    }
  }

  async function identities(
    db: Db,
    organizationId: number,
    condition?: SQL,
    limit = MAX_PAGE,
    offset = 0,
  ) {
    const { identity } = tables(base)
    return rows<IdentityRow>(
      db
        .select()
        .from(identity.table)
        .where(and(eq(identity.columns['organizationId']!, organizationId), condition))
        .orderBy(identity.columns['id']!)
        .limit(limit)
        .offset(offset),
    )
  }

  async function countIdentities(db: Db, organizationId: number, condition?: SQL) {
    const { identity } = tables(base)
    const [row] = await rows<{ total: number }>(
      db
        .select({ total: sql<number>`count(*)` })
        .from(identity.table)
        .where(and(eq(identity.columns['organizationId']!, organizationId), condition)),
    )
    return Number(row?.total ?? 0)
  }

  async function identityOf(db: Db, organizationId: number, uid: string): Promise<IdentityRow> {
    const { identity } = tables(base)
    const [row] = await identities(db, organizationId, eq(identity.columns['uid']!, uid), 1)
    if (!row) throw new ScimError(404, 'User not found.')
    return row
  }

  async function findOrCreateUser(db: Db, email: string, name: string): Promise<number> {
    const { user } = tables(base)
    const [existing] = await rows<{ id: number }>(
      db
        .select({ id: user.columns['id']! })
        .from(user.table)
        .where(eq(user.columns['email']!, email))
        .limit(1),
    )
    if (existing) return existing.id
    const now = new Date()
    // Not marked verified: a directory asserting an address is not proof the
    // person controls it. Their first verified sign-in proves ownership.
    const [created] = await rows<{ id: number }>(
      db
        .insert(user.table)
        .values({
          name: name || email,
          email,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        } as Record<string, unknown>)
        .returning({ id: user.columns['id']! }),
    )
    return created!.id
  }

  const emailSchema = z.object({
    value: z.string(),
    primary: z.union([z.boolean(), z.string()]).optional(),
  })
  const userSchema = z
    .object({
      userName: z.string().trim().min(1).max(320),
      externalId: z.string().max(255).optional(),
      displayName: z.string().max(200).optional(),
      name: z
        .object({
          formatted: z.string().optional(),
          givenName: z.string().optional(),
          familyName: z.string().optional(),
        })
        .partial()
        .optional(),
      emails: z.array(emailSchema).max(20).optional(),
      active: z.union([z.boolean(), z.string()]).optional(),
    })
    .passthrough()

  const truthy = (value: unknown) => value === true || String(value).toLowerCase() === 'true'

  function displayNameOf(body: z.infer<typeof userSchema>): string {
    return (
      body.displayName ||
      body.name?.formatted ||
      [body.name?.givenName, body.name?.familyName].filter(Boolean).join(' ') ||
      ''
    ).slice(0, 200)
  }

  function emailFrom(body: z.infer<typeof userSchema>): string {
    const primary = body.emails?.find((entry) => truthy(entry.primary)) ?? body.emails?.[0]
    const email = (primary?.value ?? body.userName).trim().toLowerCase()
    if (!EMAIL.test(email)) {
      throw new ScimError(
        400,
        'Provide a work email as userName or emails[].value.',
        'invalidValue',
      )
    }
    return email
  }

  async function applyActive(
    db: Db,
    env: Record<string, unknown> | undefined,
    identity: IdentityRow,
    active: boolean,
  ) {
    if (active) {
      await ensureMembership(base, db, identity.userId, identity.organizationId, scim.defaultRole)
    } else {
      await removeMembership(base, db, env, identity.userId, identity.organizationId)
    }
  }

  async function update(
    db: Db,
    row: IdentityRow,
    patch: Partial<Pick<IdentityRow, 'userName' | 'externalId' | 'displayName' | 'active'>>,
  ) {
    const { identity } = tables(base)
    const [updated] = await rows<IdentityRow>(
      db
        .update(identity.table)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(identity.columns['id']!, row.id))
        .returning(),
    )
    return updated!
  }

  const scimJson = (c: Context<Bindings>, body: unknown, status = 200) =>
    c.body(JSON.stringify(body), status as 200, { 'content-type': 'application/scim+json' })

  app.get('/ServiceProviderConfig', (c) =>
    scimJson(c, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_PAGE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description: 'Organization SCIM token',
          primary: true,
        },
      ],
    }),
  )

  app.get('/ResourceTypes', (c) =>
    scimJson(c, {
      schemas: [LIST_SCHEMA],
      totalResults: 1,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: USER_SCHEMA,
        },
      ],
    }),
  )

  app.get('/Schemas', (c) =>
    scimJson(c, {
      schemas: [LIST_SCHEMA],
      totalResults: 1,
      Resources: [{ id: USER_SCHEMA, name: 'User', description: 'User account' }],
    }),
  )

  app.get('/Users', async (c) => {
    const { db, organizationId } = await caller(c)
    const { identity } = tables(base)
    const startIndex = Math.max(1, Number(c.req.query('startIndex') ?? 1) || 1)
    const count = Math.min(
      MAX_PAGE,
      Math.max(0, Number(c.req.query('count') ?? MAX_PAGE) || MAX_PAGE),
    )
    const filter = c.req.query('filter')?.trim()
    let condition: SQL | undefined
    if (filter) {
      const match = /^(userName|externalId|emails(?:\.value)?)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i.exec(
        filter,
      )
      if (!match) {
        throw new ScimError(
          400,
          'Only "userName eq", "externalId eq" and "emails eq" filters are supported.',
          'invalidFilter',
        )
      }
      const value = match[2]!.replace(/\\"/g, '"')
      const attribute = match[1]!.toLowerCase()
      condition =
        attribute === 'externalid'
          ? eq(identity.columns['externalId']!, value)
          : eq(identity.columns['userName']!, value.toLowerCase())
    }
    const totalResults = await countIdentities(db, organizationId, condition)
    const page =
      count > 0 ? await identities(db, organizationId, condition, count, startIndex - 1) : []
    return scimJson(c, {
      schemas: [LIST_SCHEMA],
      totalResults,
      startIndex,
      itemsPerPage: page.length,
      Resources: await Promise.all(page.map((row) => resource(c, db, row))),
    })
  })

  app.get('/Users/:id', async (c) => {
    const { db, organizationId } = await caller(c)
    return scimJson(
      c,
      await resource(c, db, await identityOf(db, organizationId, c.req.param('id'))),
    )
  })

  app.post('/Users', async (c) => {
    const { db, organizationId } = await caller(c)
    const body = userSchema.parse(await c.req.json())
    const email = emailFrom(body)
    const userName = body.userName.toLowerCase()
    const { identity } = tables(base)
    const [taken] = await identities(
      db,
      organizationId,
      eq(identity.columns['userName']!, userName),
      1,
    )
    if (taken) {
      throw new ScimError(409, 'A user with that userName is already provisioned.', 'uniqueness')
    }
    const userId = await findOrCreateUser(db, email, displayNameOf(body))
    const active = body.active === undefined ? true : truthy(body.active)
    const now = Date.now()
    const [created] = await rows<IdentityRow>(
      db
        .insert(identity.table)
        .values({
          uid: crypto.randomUUID(),
          organizationId,
          userId,
          userName,
          externalId: body.externalId ?? '',
          displayName: displayNameOf(body),
          active,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    )
    await applyActive(db, c.env, created!, active)
    return scimJson(c, await resource(c, db, created!), 201)
  })

  app.put('/Users/:id', async (c) => {
    const { db, organizationId } = await caller(c)
    const row = await identityOf(db, organizationId, c.req.param('id'))
    const body = userSchema.parse(await c.req.json())
    const active = body.active === undefined ? row.active : truthy(body.active)
    const updated = await update(db, row, {
      userName: body.userName.toLowerCase(),
      externalId: body.externalId ?? row.externalId,
      displayName: displayNameOf(body) || row.displayName,
      active,
    })
    if (active !== row.active) await applyActive(db, c.env, updated, active)
    return scimJson(c, await resource(c, db, updated))
  })

  app.patch('/Users/:id', async (c) => {
    const { db, organizationId } = await caller(c)
    const row = await identityOf(db, organizationId, c.req.param('id'))
    const body = z
      .object({
        schemas: z.array(z.string()).optional(),
        Operations: z
          .array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown() }))
          .max(50),
      })
      .parse(await c.req.json())
    if (body.schemas && !body.schemas.includes(PATCH_SCHEMA)) {
      throw new ScimError(400, 'Send a SCIM PatchOp message.', 'invalidSyntax')
    }
    const patch: Partial<Pick<IdentityRow, 'userName' | 'externalId' | 'displayName' | 'active'>> =
      {}
    for (const operation of body.Operations) {
      const op = operation.op.toLowerCase()
      if (op !== 'replace' && op !== 'add') continue
      // Okta sends { value: { active: false } }; Entra sends { path: 'active', value: 'False' }.
      const values: Record<string, unknown> = operation.path
        ? { [operation.path]: operation.value }
        : ((operation.value ?? {}) as Record<string, unknown>)
      for (const [path, value] of Object.entries(values)) {
        const key = path.toLowerCase()
        if (key === 'active') {
          patch.active = truthy(value)
        } else if (typeof value !== 'string') {
          continue
        } else if (key === 'username') {
          patch.userName = value.toLowerCase()
        } else if (key === 'externalid') {
          patch.externalId = value
        } else if (key === 'displayname' || key === 'name.formatted') {
          patch.displayName = value.slice(0, 200)
        }
      }
    }
    const updated = Object.keys(patch).length ? await update(db, row, patch) : row
    if (patch.active !== undefined && patch.active !== row.active) {
      await applyActive(db, c.env, updated, patch.active)
    }
    return scimJson(c, await resource(c, db, updated))
  })

  app.delete('/Users/:id', async (c) => {
    const { db, organizationId } = await caller(c)
    const row = await identityOf(db, organizationId, c.req.param('id'))
    await removeMembership(base, db, c.env, row.userId, organizationId)
    const { identity } = tables(base)
    await rows(db.delete(identity.table).where(eq(identity.columns['id']!, row.id)))
    return c.body(null, 204)
  })

  const groupsUnsupported = (c: Context<Bindings>) =>
    scimJson(
      c,
      { schemas: [ERROR_SCHEMA], status: '501', detail: 'Groups are not supported.' },
      501,
    )
  app.all('/Groups', groupsUnsupported)
  app.all('/Groups/*', groupsUnsupported)

  app.onError((error, c) => {
    if (error instanceof ScimError) {
      return scimJson(
        c,
        {
          schemas: [ERROR_SCHEMA],
          status: String(error.status),
          detail: error.message,
          ...(error.scimType ? { scimType: error.scimType } : {}),
        },
        error.status,
      )
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return scimJson(
        c,
        {
          schemas: [ERROR_SCHEMA],
          status: '400',
          scimType: 'invalidSyntax',
          detail: 'Invalid SCIM request body.',
        },
        400,
      )
    }
    console.error('[cloudconfig:scim]', error)
    return scimJson(
      c,
      { schemas: [ERROR_SCHEMA], status: '500', detail: 'SCIM request failed.' },
      500,
    )
  })

  return app
}

/* ------------------------------------------------------------------ */
/* /scim-connections — what organization admins call                   */
/* ------------------------------------------------------------------ */

/** Owner/admin routes for an organization's SCIM tokens, under `<auth>/scim-connections`. */
export function scimAdminApp(
  base: CompiledBase,
  auth: ResolvedAuth,
  dbFor: (ctx: Ctx) => Promise<Db>,
  instanceFor: (ctx: Ctx) => Promise<AuthInstance>,
) {
  const app = new Hono<Bindings>()
  const membership = membershipLookup(base)
  const lifetimeMs = auth.scim!.tokenLifetimeDays * 24 * 60 * 60 * 1000

  async function admin(c: Context<Bindings>) {
    const ctx = { request: c.req.raw, env: c.env }
    const instance = await instanceFor(ctx)
    const session = await instance.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    })
    if (!session) throw new ScimError(401, 'Sign in first.')
    const userId = Number(session.user.id)
    const organizationId = Number(
      (session.session as { activeOrganizationId?: unknown }).activeOrganizationId,
    )
    if (!Number.isSafeInteger(organizationId) || organizationId <= 0) {
      throw new ScimError(400, 'Choose an organization first.')
    }
    const db = await dbFor(ctx)
    const member = await membership(db, userId, organizationId)
    if (!member || !member.role.split(',').some((role) => ADMIN_ROLES.includes(role.trim()))) {
      throw new ScimError(403, 'Only organization owners and admins manage provisioning.')
    }
    return { db, userId, organizationId }
  }

  type TokenRow = {
    uid: string
    label: string
    createdAt: number
    expiresAt: number
    lastUsedAt: number | null
    revokedAt: number | null
  }

  /** What admins see of a token: never its hash. */
  function tokenFields() {
    const { columns } = tables(base).token
    return {
      uid: columns['uid']!,
      label: columns['label']!,
      createdAt: columns['createdAt']!,
      expiresAt: columns['expiresAt']!,
      lastUsedAt: columns['lastUsedAt']!,
      revokedAt: columns['revokedAt']!,
    }
  }

  app.get('/', async (c) => {
    const { db, organizationId } = await admin(c)
    const { token } = tables(base)
    const list = await rows<TokenRow>(
      db
        .select(tokenFields())
        .from(token.table)
        .where(eq(token.columns['organizationId']!, organizationId))
        .orderBy(token.columns['id']!),
    )
    return c.json({ tokens: list, baseUrl: scimBaseUrl(auth, c) })
  })

  app.post('/', async (c) => {
    const { db, userId, organizationId } = await admin(c)
    const body = z
      .object({ label: z.string().max(120).optional() })
      .strict()
      .parse(await c.req.json().catch(() => ({})))
    const secret = randomToken('scim')
    const { token } = tables(base)
    const now = Date.now()
    const [created] = await rows<TokenRow>(
      db
        .insert(token.table)
        .values({
          uid: crypto.randomUUID(),
          organizationId,
          tokenHash: await sha256Hex(secret),
          label: body.label ?? '',
          createdBy: userId,
          createdAt: now,
          expiresAt: now + lifetimeMs,
        })
        .returning(tokenFields()),
    )
    return c.json({ token: secret, baseUrl: scimBaseUrl(auth, c), credential: created }, 201)
  })

  app.post('/revoke', async (c) => {
    const { db, organizationId } = await admin(c)
    const body = z
      .object({ id: z.string().min(1).max(64) })
      .strict()
      .parse(await c.req.json())
    const { token } = tables(base)
    const revoked = await rows<{ uid: string }>(
      db
        .update(token.table)
        .set({ revokedAt: Date.now() })
        .where(
          and(
            eq(token.columns['uid']!, body.id),
            eq(token.columns['organizationId']!, organizationId),
          ),
        )
        .returning({ uid: token.columns['uid']! }),
    )
    if (revoked.length === 0) throw new ScimError(404, 'Token not found.')
    return c.json({ revoked: body.id })
  })

  app.onError((error, c) => {
    if (error instanceof ScimError) {
      return c.json({ error: 'SCIM', message: error.message }, error.status as 400)
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Bad request', message: 'Invalid request.' }, 400)
    }
    console.error('[cloudconfig:scim]', error)
    return c.json({ error: 'SCIM', message: 'SCIM request failed.' }, 500)
  })

  return app
}
