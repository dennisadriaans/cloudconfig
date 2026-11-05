import { Hono } from 'hono'
import { z } from 'zod'
import type { ResolvedAuth } from '../../shared/auth-resolve.js'
import type { FilterNode } from '../../dsl/filters.js'
import type { CompiledBase } from '../compile/index.js'
import type { Db } from '../driver.js'
import { drizzleSqliteAdapter } from '../adapters/drizzle-sqlite.js'
import { parseListParams } from '../list-query.js'
import type { AuthInstance } from './types.js'

type Context = { request: Request; env: Record<string, unknown> | undefined }
const fields = new Set([
  'id',
  'name',
  'email',
  'emailVerified',
  'image',
  'createdAt',
  'updatedAt',
  'role',
  'banned',
  'banReason',
  'banExpires',
])
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.email(),
    password: z.string().min(8).optional(),
    role: z.union([z.string(), z.array(z.string())]).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.email().optional(),
    emailVerified: z.boolean().optional(),
    image: z.url().nullable().optional(),
    role: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict()

function allowedFilter(node: FilterNode): boolean {
  return node.type === 'group' ? node.children.every(allowedFilter) : fields.has(node.field)
}

function userRow(row: Record<string, unknown>) {
  return Object.fromEntries([...fields].map((key) => [key, row[key] ?? null]))
}

function isAdmin(auth: ResolvedAuth, user: { id: string | number; role?: unknown }): boolean {
  if (!auth.admin) return false
  if (auth.admin.userIds?.includes(Number(user.id))) return true
  const allowed = Array.isArray(auth.admin.adminRoles)
    ? auth.admin.adminRoles
    : [auth.admin.adminRoles ?? 'admin']
  const actual =
    typeof user.role === 'string' ? user.role.split(',').map((role) => role.trim()) : []
  return actual.some((role) => allowed.includes(role))
}

export function adminApp(
  base: CompiledBase,
  auth: ResolvedAuth,
  dbFor: (ctx: Context) => Promise<Db>,
  instanceFor: (ctx: Context) => Promise<AuthInstance>,
) {
  const app = new Hono<{
    Bindings: Record<string, unknown>
    Variables: { instance: AuthInstance }
  }>()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const request = c.req.raw
    const instance = await instanceFor({ request, env: c.env })
    const session = await instance.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    })
    if (!session) return c.json({ message: 'Sign in to manage users.' }, 401)
    if (!isAdmin(auth, session.user)) {
      return c.json({ message: 'Your account does not have permission to manage users.' }, 403)
    }
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin')
      if (
        (origin &&
          origin !== new URL(request.url).origin &&
          !auth.trustedOrigins.includes(origin)) ||
        request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
      ) {
        return c.json({ message: 'Invalid request origin or content type.' }, 403)
      }
    }
    c.set('instance', instance)
    await next()
  })

  app.get('/access', (c) => c.json({ allowed: true }))

  app.get('/users', async (c) => {
    const query = parseListParams(new URL(c.req.url))
    if (
      (query.sortBy && !fields.has(query.sortBy)) ||
      (query.filters && !allowedFilter(query.filters))
    ) {
      return c.json({ message: 'Unknown user query field.' }, 400)
    }
    const db = await dbFor({ request: c.req.raw, env: c.env })
    const model = base.models['user']!
    const adapter = drizzleSqliteAdapter(base, db, [...fields])
    const result = await adapter.list(model.name, query)
    return c.json({ ...result, data: result.data.map(userRow) })
  })

  app.post('/users', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        { message: 'Enter a name and valid email address.', issues: parsed.error.issues },
        400,
      )
    }
    const response = await c.get('instance').api.createUser({
      headers: c.req.raw.headers,
      body: {
        name: parsed.data.name,
        email: parsed.data.email,
        ...(parsed.data.password !== undefined ? { password: parsed.data.password } : {}),
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        ...(parsed.data.data !== undefined ? { data: parsed.data.data } : {}),
      },
      asResponse: true,
    })
    if (!response.ok) return response
    const body = (await response.json()) as { user: Record<string, unknown> }
    return c.json(userRow({ ...body.user, id: Number(body.user['id']) }), 201)
  })

  app.patch('/users/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ message: 'Invalid user ID.' }, 400)
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return c.json({ message: 'Enter at least one valid user field to update.' }, 400)
    }
    const response = await c.get('instance').api.adminUpdateUser({
      headers: c.req.raw.headers,
      body: {
        userId: String(id),
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
          ...(parsed.data.emailVerified !== undefined
            ? { emailVerified: parsed.data.emailVerified }
            : {}),
          ...(parsed.data.image !== undefined ? { image: parsed.data.image } : {}),
          ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        },
      },
      asResponse: true,
    })
    if (!response.ok) return response
    const user = (await response.json()) as Record<string, unknown>
    return c.json(userRow({ ...user, id: Number(user['id']) }))
  })

  app.delete('/users/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ message: 'Invalid user ID.' }, 400)
    const response = await c.get('instance').api.removeUser({
      headers: c.req.raw.headers,
      body: { userId: String(id) },
      asResponse: true,
    })
    return response.ok ? c.body(null, 204) : response
  })
  return app
}
