import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import type { Db, DbProvider } from '../src/server/driver.js'

// A config with a relation, a select, a default, and access rules.
function makeConfig(access?: Parameters<typeof model>[1]) {
  return defineBackend({
    models: {
      user: model({
        name: t.text().required(),
        email: t.email().required().unique(),
      }),
      post: model(
        {
          title: t.text().required(),
          body: t.textarea(),
          status: t.select(['draft', 'published']).default('draft'),
          author: t.relation('user'),
        },
        access,
      ),
    },
    access: { default: 'allow' },
  })
}

// The schema is derived by hand here to seed an in-memory db for the test.
function freshDb(): DbProvider {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT, status TEXT DEFAULT 'draft', author_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `)
  const db: Db = drizzle(sqlite)
  return { id: 'test', connect: (): Db => db }
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

it('logs unhandled errors while keeping the production response generic', async () => {
  const failure = new Error('Authentication runtime failed')
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubEnv('NODE_ENV', 'production')

  try {
    const app = createBackend(makeConfig(), {
      getUser() {
        throw failure
      },
    })
    const response = await req(app, 'GET', '/api/users')

    expect(response).toEqual({
      status: 500,
      body: { error: 'Database error', message: 'Internal server error' },
    })
    expect(errorLog).toHaveBeenCalledWith('[cloudconfig] Unhandled request error:', failure)
  } finally {
    errorLog.mockRestore()
    vi.unstubAllEnvs()
  }
})

describe('CRUD', () => {
  it('denies anonymous list and create when no access rule is configured', async () => {
    const app = createBackend(
      defineBackend({ models: { post: model({ title: t.text().required() }) } }),
    )
    expect((await req(app, 'GET', '/api/posts')).status).toBe(403)
    expect((await req(app, 'POST', '/api/posts', { title: 'Denied' })).status).toBe(403)
  })
  let app: ReturnType<typeof createBackend>

  beforeEach(() => {
    app = createBackend(makeConfig(), { db: freshDb() })
  })

  it('creates and reads a record', async () => {
    const created = await req(app, 'POST', '/api/users', { name: 'Ada', email: 'ada@x.com' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ id: 1, name: 'Ada', email: 'ada@x.com' })
    expect(created.body.createdAt).toBeTruthy()

    const read = await req(app, 'GET', '/api/users/1')
    expect(read.status).toBe(200)
    expect(read.body.name).toBe('Ada')
  })

  it('applies a default on create', async () => {
    await req(app, 'POST', '/api/users', { name: 'Ada', email: 'ada@x.com' })
    const post = await req(app, 'POST', '/api/posts', { title: 'Hello', authorId: 1 })
    expect(post.status).toBe(201)
    expect(post.body.status).toBe('draft')
  })

  it('returns 400 on invalid input', async () => {
    const res = await req(app, 'POST', '/api/users', { name: 'Ada' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Validation failed')
    expect(Array.isArray(res.body.issues)).toBe(true)
  })

  it('returns 404 for unknown resource and missing row', async () => {
    expect((await req(app, 'GET', '/api/widgets')).status).toBe(404)
    expect((await req(app, 'GET', '/api/users/999')).status).toBe(404)
  })

  it('updates via PATCH and PUT (both partial)', async () => {
    await req(app, 'POST', '/api/users', { name: 'Ada', email: 'ada@x.com' })
    const patched = await req(app, 'PATCH', '/api/users/1', { name: 'Ada L.' })
    expect(patched.status).toBe(200)
    expect(patched.body.name).toBe('Ada L.')
    expect(patched.body.email).toBe('ada@x.com')

    const put = await req(app, 'PUT', '/api/users/1', { name: 'Ada Lovelace' })
    expect(put.body.name).toBe('Ada Lovelace')
  })

  it('deletes a record', async () => {
    await req(app, 'POST', '/api/users', { name: 'Ada', email: 'ada@x.com' })
    const del = await req(app, 'DELETE', '/api/users/1')
    expect(del.status).toBe(204)
    expect((await req(app, 'GET', '/api/users/1')).status).toBe(404)
  })

  it('persists explicitly cleared optional relations and fields', async () => {
    await req(app, 'POST', '/api/users', { name: 'Ada', email: 'ada@x.com' })
    await req(app, 'POST', '/api/posts', { title: 'Keep this', body: 'Old text', authorId: 1 })
    const patched = await req(app, 'PATCH', '/api/posts/1', { body: null, authorId: null })
    expect(patched.status).toBe(200)
    expect(patched.body).toMatchObject({ title: 'Keep this', body: null, author: null })
    expect((await req(app, 'GET', '/api/posts/1')).body).toMatchObject({ body: null, author: null })
    expect((await req(app, 'PATCH', '/api/posts/1', { title: null })).status).toBe(400)
  })
})

describe('list pipeline', () => {
  let app: ReturnType<typeof createBackend>

  beforeEach(async () => {
    app = createBackend(makeConfig(), { db: freshDb() })
    await req(app, 'POST', '/api/users', { name: 'Ada', email: 'ada@x.com' })
    for (let i = 1; i <= 5; i++) {
      await req(app, 'POST', '/api/posts', {
        title: `Post ${i}`,
        authorId: 1,
        status: i % 2 === 0 ? 'published' : 'draft',
      })
    }
  })

  it('returns a PagedResult envelope', async () => {
    const res = await req(app, 'GET', '/api/posts')
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual([
      'data',
      'page',
      'pageSize',
      'totalCount',
      'totalPages',
    ])
    expect(res.body.totalCount).toBe(5)
    expect(res.body.data).toHaveLength(5)
  })

  it('paginates', async () => {
    const res = await req(app, 'GET', '/api/posts?page=2&pageSize=2')
    expect(res.body.page).toBe(2)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.totalPages).toBe(3)
  })

  it('expands a belongs-to relation into a nested object and omits the FK', async () => {
    const res = await req(app, 'GET', '/api/posts/1')
    expect(res.body.author).toMatchObject({ id: 1, name: 'Ada' })
    expect(res.body.authorId).toBeUndefined()
  })

  it('searches string columns', async () => {
    const res = await req(app, 'GET', '/api/posts?search=Post%203')
    expect(res.body.totalCount).toBe(1)
    expect(res.body.data[0].title).toBe('Post 3')
  })

  it('sorts', async () => {
    const res = await req(app, 'GET', '/api/posts?sortBy=title&sortDir=desc')
    expect(res.body.data[0].title).toBe('Post 5')
  })

  it('filters via the filters= AST', async () => {
    const filters = encodeURIComponent(
      JSON.stringify({
        type: 'group',
        logic: 'and',
        children: [{ type: 'condition', field: 'status', operator: 'eq', value: 'published' }],
      }),
    )
    const res = await req(app, 'GET', `/api/posts?filters=${filters}`)
    expect(res.body.totalCount).toBe(2)
  })
})

describe('access rules', () => {
  it('denies list when the rule returns false', async () => {
    const app = createBackend(makeConfig({ access: { list: () => false } }), { db: freshDb() })
    const res = await req(app, 'GET', '/api/posts')
    expect(res.status).toBe(403)
  })

  it('scopes list to a filter predicate', async () => {
    const app = createBackend(
      makeConfig({ access: { list: ({ where }) => where('status', 'eq', 'published') } }),
      { db: freshDb() },
    )
    await req(app, 'POST', '/api/users', { name: 'Ada', email: 'ada@x.com' })
    await req(app, 'POST', '/api/posts', { title: 'D', authorId: 1, status: 'draft' })
    await req(app, 'POST', '/api/posts', { title: 'P', authorId: 1, status: 'published' })
    const res = await req(app, 'GET', '/api/posts')
    expect(res.body.totalCount).toBe(1)
    expect(res.body.data[0].title).toBe('P')
  })

  it('returns 404 (not 403) when a row-level update rule denies', async () => {
    const app = createBackend(makeConfig({ access: { update: () => false } }), { db: freshDb() })
    await req(app, 'POST', '/api/users', { name: 'Ada', email: 'ada@x.com' })
    await req(app, 'POST', '/api/posts', { title: 'X', authorId: 1 })
    const res = await req(app, 'PATCH', '/api/posts/1', { title: 'Y' })
    expect(res.status).toBe(404)
  })
})

describe('hooks', () => {
  it('runs beforeCreate to transform input and afterChange', async () => {
    const events: string[] = []
    const config = makeConfig({
      hooks: {
        beforeCreate: (_ctx, input) => ({ ...input, title: `[hooked] ${String(input['title'])}` }),
        afterChange: (_ctx, ev) => {
          events.push(ev.action)
        },
      },
    })
    const app = createBackend(config, { db: freshDb() })
    await req(app, 'POST', '/api/users', { name: 'Ada', email: 'ada@x.com' })
    const post = await req(app, 'POST', '/api/posts', { title: 'Hi', authorId: 1 })
    expect(post.body.title).toBe('[hooked] Hi')
    expect(events).toContain('create')
  })
})

describe('docs', () => {
  it('serves an HTML docs page', async () => {
    const app = createBackend(makeConfig(), { db: freshDb() })
    const res = await app.request('http://localhost/api/_docs')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('API Reference')
    expect(html).toContain('SwaggerUIBundle')
    expect(html).toContain('url: "/api/openapi.json"')
  })
})

describe('missing database driver', () => {
  it('names both local sqliteFile and Cloudflare d1 when no driver is configured', async () => {
    const app = createBackend(makeConfig())
    const res = await app.request('http://localhost/api/users')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { message: string }
    expect(body.message).toMatch(/sqliteFile\("\.cloudconfig\/dev\.db"\)/)
    expect(body.message).toMatch(/d1\("DB"\)/)
  })

  it('still fails when env is present but has no D1 binding', async () => {
    const { autoDetectDriver } = await import('../src/server/driver-detect.js')
    expect(() => autoDetectDriver({ DB: 'not-a-binding' })).toThrow(/No database configured/)
    expect(() => autoDetectDriver(undefined)).toThrow(/sqliteFile/)
  })
})
