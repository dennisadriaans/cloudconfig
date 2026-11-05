/**
 * Proof of the hexagon, in two parts:
 *
 * 1. The whole REST backend runs against an in-memory provider — no drizzle, no
 *    SQLite, no driver. A Postgres or different-ORM adapter only has to
 *    implement the same `DataAdapter` interface.
 * 2. The operations core runs with no Hono/HTTP at all, which is what a gRPC
 *    or RPC transport adapter would do.
 */
import { describe, expect, it } from 'vitest'
import { memoryProvider } from './memory-provider.js'
import { defineBackend, model, t } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { createOperations } from '../src/server/operations.js'
import type { GetUser } from '../src/server/ports.js'

// Fixtures for the transport-level tests.

function makeConfig(access?: Parameters<typeof model>[1]) {
  return defineBackend({
    models: {
      note: model(
        {
          title: t.text().required(),
          status: t.select(['draft', 'published']).default('draft'),
        },
        access,
      ),
    },
    access: { default: 'allow' },
  })
}

function makeApp(access?: Parameters<typeof model>[1], getUser?: GetUser) {
  const config = makeConfig(access)
  const provider = memoryProvider(config)
  const app = createBackend(config, { data: provider, ...(getUser ? { getUser } : {}) })
  return { app, provider }
}

async function req(
  app: ReturnType<typeof createBackend>,
  method: string,
  path: string,
  body?: unknown,
) {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await app.request(`http://localhost${path}`, init)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// REST over the memory adapter — the engine/ORM swap, end to end.

describe('createBackend over a custom DataProvider (no drizzle, no SQLite)', () => {
  it('serves full CRUD', async () => {
    const { app } = makeApp()

    const created = await req(app, 'POST', '/api/notes', { title: 'Hello' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ id: 1, title: 'Hello' })
    expect(created.body.createdAt).toBeTruthy()

    const read = await req(app, 'GET', '/api/notes/1')
    expect(read.status).toBe(200)
    expect(read.body.title).toBe('Hello')

    const patched = await req(app, 'PATCH', '/api/notes/1', { title: 'Hi' })
    expect(patched.status).toBe(200)
    expect(patched.body.title).toBe('Hi')
    expect(patched.body.updatedAt).toBeTruthy()

    const list = await req(app, 'GET', '/api/notes')
    expect(list.body.totalCount).toBe(1)

    const del = await req(app, 'DELETE', '/api/notes/1')
    expect(del.status).toBe(204)
    expect((await req(app, 'GET', '/api/notes/1')).status).toBe(404)
  })

  it('still validates with zod before the adapter is reached', async () => {
    const { app, provider } = makeApp()
    const res = await req(app, 'POST', '/api/notes', {})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Validation failed')
    expect(provider.rows('note')).toHaveLength(0)
  })

  it('applies access-rule FilterNode predicates portably', async () => {
    const { app } = makeApp({ access: { list: ({ where }) => where('status', 'eq', 'published') } })
    await req(app, 'POST', '/api/notes', { title: 'D', status: 'draft' })
    await req(app, 'POST', '/api/notes', { title: 'P', status: 'published' })

    const res = await req(app, 'GET', '/api/notes')
    expect(res.body.totalCount).toBe(1)
    expect(res.body.data[0].title).toBe('P')
  })

  it('hides denied rows from mutations as 404', async () => {
    const { app } = makeApp({
      access: { update: ({ where }) => where('status', 'eq', 'published') },
    })
    await req(app, 'POST', '/api/notes', { title: 'D', status: 'draft' })
    expect((await req(app, 'PATCH', '/api/notes/1', { title: 'X' })).status).toBe(404)
  })

  it('resolves the caller through the getUser port', async () => {
    const { app } = makeApp({ access: { list: ({ user }) => user != null } }, (request) =>
      request.headers.get('authorization') === 'Bearer ok' ? { id: 1 } : null,
    )
    expect((await req(app, 'GET', '/api/notes')).status).toBe(403)

    const authed = await app.request('http://localhost/api/notes', {
      headers: { authorization: 'Bearer ok' },
    })
    expect(authed.status).toBe(200)
  })
})

// The operations core without HTTP — what a gRPC/RPC adapter would call.

describe('createOperations without a transport', () => {
  it('runs CRUD as plain function calls returning OpResults', async () => {
    const config = makeConfig()
    const ops = createOperations(config, { data: memoryProvider(config) })
    const ctx = { request: new Request('http://internal/') }

    const created = await ops.create(ctx, 'notes', { title: 'From RPC' })
    expect(created.ok).toBe(true)
    if (created.ok) expect(created.value['title']).toBe('From RPC')

    const listed = await ops.list(ctx, 'notes', { page: 1, pageSize: 10, sortDir: 'asc' })
    expect(listed.ok && listed.value.totalCount).toBe(1)

    const invalid = await ops.create(ctx, 'notes', {})
    expect(!invalid.ok && invalid.code).toBe('validation')

    const missing = await ops.get(ctx, 'notes', 999)
    expect(!missing.ok && missing.code).toBe('not_found')

    const unknown = await ops.list(ctx, 'widgets', { page: 1, pageSize: 10, sortDir: 'asc' })
    expect(!unknown.ok && unknown.code).toBe('unknown_model')
  })
})
