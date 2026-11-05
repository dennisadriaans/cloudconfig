import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'
import { d1Http } from '../src/drivers/d1-http.js'
import { configuredDatabase } from '../src/drivers/configured.js'
import { createBackend } from '../src/server/backend.js'
import { defineBackend, model, t } from '../src/index.js'
import { compileConfig } from '../src/server/compile/index.js'
import { schemaStatements } from '../src/server/schema-sql.js'

const env = {
  NODE_ENV: 'production',
  CLOUDCONFIG_D1_ACCOUNT_ID: 'account',
  CLOUDCONFIG_D1_DATABASE_ID: 'database',
  CLOUDCONFIG_D1_API_TOKEN: 'private-token',
}
afterEach(() => vi.unstubAllGlobals())

it('runs model CRUD against the same D1 schema through the remote adapter', async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(
    'CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  )
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/raw',
    )
    expect(init.headers).toMatchObject({ Authorization: 'Bearer private-token' })
    const { sql, params } = JSON.parse(String(init.body))
    const statement = sqlite.prepare(sql)
    const columns = statement.columns().map(({ name }) => name)
    const rows = statement.raw().all(...params)
    return Response.json({ success: true, result: [{ success: true, results: { columns, rows } }] })
  })
  vi.stubGlobal('fetch', fetch)
  try {
    const config = defineBackend({
      db: { remote: { provider: 'd1' } },
      deploy: { target: 'vercel' },
      access: { default: 'allow' },
      models: { note: model({ title: t.text().required() }) },
    })
    const app = createBackend(config, { db: configuredDatabase(config) })
    const created = await app.request(
      '/api/notes',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'portable note' }),
      },
      env,
    )
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ title: 'portable note' })
    const listed = await app.request('/api/notes', {}, env)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ data: [{ title: 'portable note' }] })
  } finally {
    sqlite.close()
  }
})

it('surfaces D1 failures instead of returning empty success-looking rows', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ success: false, errors: [{ message: 'access denied' }] }, { status: 403 }),
    ),
  )
  const db = await d1Http().connect({ env, request: new Request('https://example.com') })
  await expect(db.all(sql`SELECT 1`)).rejects.toThrow()
})

it('never silently creates a local production database without remote settings', async () => {
  const provider = configuredDatabase(defineBackend({ models: {} }))
  await expect(
    provider.connect({
      env: { NODE_ENV: 'production' },
      request: new Request('https://example.com'),
    }),
  ).rejects.toThrow('Remote D1 requires')
})

it('keeps sign-up and session authorization working through remote D1', async () => {
  const config = defineBackend({
    auth: { emailPassword: true, proxy: false },
    models: { note: model({ title: t.text() }, { access: { list: ({ user }) => !!user } }) },
  })
  const sqlite = new Database(':memory:')
  for (const statement of schemaStatements(compileConfig(config))) sqlite.exec(statement.sql)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const { sql, params } = JSON.parse(String(init.body))
      const statement = sqlite.prepare(sql)
      const columns = statement.reader ? statement.columns().map(({ name }) => name) : []
      const rows = statement.reader ? statement.raw().all(...params) : []
      if (!statement.reader) statement.run(...params)
      return Response.json({
        success: true,
        result: [{ success: true, results: { columns, rows } }],
      })
    }),
  )
  const production = {
    ...env,
    BETTER_AUTH_SECRET: 'test-only-signing-secret-with-more-than-32-characters',
  }
  try {
    const app = createBackend(config, { db: configuredDatabase(config) })
    const response = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
        body: JSON.stringify({
          name: 'Portable User',
          email: 'portable@example.com',
          password: 'portable-password-12345',
        }),
      },
      production,
    )
    expect(response.status, await response.clone().text()).toBe(200)
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    expect((await app.request('http://localhost/api/notes', {}, production)).status).toBe(403)
    expect(
      (await app.request('http://localhost/api/notes', { headers: { cookie } }, production)).status,
    ).toBe(200)
    expect(sqlite.prepare('SELECT email FROM users').all()).toEqual([
      { email: 'portable@example.com' },
    ])
  } finally {
    sqlite.close()
  }
})
