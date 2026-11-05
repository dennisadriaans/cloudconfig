import { createClient, type Client } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { configuredDatabase } from '../src/drivers/configured.js'
import { createBackend } from '../src/server/backend.js'
import { compileConfig } from '../src/server/compile/index.js'
import { schemaStatements } from '../src/server/schema-sql.js'

const { createRemoteClient } = vi.hoisted(() => ({ createRemoteClient: vi.fn() }))
vi.mock('@libsql/client/web', () => ({ createClient: createRemoteClient }))

const clients: Client[] = []
const production = {
  NODE_ENV: 'production',
  TURSO_DATABASE_URL: 'libsql://notes.turso.io',
  TURSO_AUTH_TOKEN: 'turso-token',
}
const request = new Request('https://notes.example.com')

beforeEach(() => {
  createRemoteClient.mockImplementation(() => {
    // Exercise the real libSQL/Drizzle stack locally; only the remote connection is replaced.
    const client = createClient({ url: 'file::memory:' })
    clients.push(client)
    return client
  })
})

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  vi.clearAllMocks()
})

it('uses Turso for Vercel sign-up, session authorization and model CRUD', async () => {
  const config = defineBackend({
    deploy: { target: 'vercel' },
    auth: { emailPassword: true, proxy: false },
    models: {
      note: model(
        { title: t.text().required() },
        { access: { list: ({ user }) => !!user, create: ({ user }) => !!user } },
      ),
    },
  })
  const provider = configuredDatabase(config)
  const env = {
    ...production,
    BETTER_AUTH_SECRET: 'test-only-signing-secret-with-more-than-32-characters',
    // A stale D1 binding must not override the selected provider.
    DB: {},
  }
  const database = await provider.connect({ env, request })
  for (const statement of schemaStatements(compileConfig(config))) {
    await database.run(sql.raw(statement.sql))
  }
  const app = createBackend(config, { db: provider })
  const response = await app.request(
    'http://localhost/api/auth/sign-up/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: JSON.stringify({
        name: 'Turso User',
        email: 'turso@example.com',
        password: 'turso-password-12345',
      }),
    },
    env,
  )
  expect(response.status, await response.clone().text()).toBe(200)
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  expect((await app.request('http://localhost/api/notes', {}, env)).status).toBe(403)
  const created = await app.request(
    'http://localhost/api/notes',
    {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Turso note' }),
    },
    env,
  )
  expect(created.status, await created.clone().text()).toBe(201)
  const listed = await app.request('http://localhost/api/notes', { headers: { cookie } }, env)
  expect(listed.status).toBe(200)
  expect(await listed.json()).toMatchObject({ data: [{ title: 'Turso note' }] })
  expect(createRemoteClient).toHaveBeenCalledExactlyOnceWith({
    url: production.TURSO_DATABASE_URL,
    authToken: production.TURSO_AUTH_TOKEN,
  })
})

it('uses local SQLite during development even when the project targets Vercel', async () => {
  const provider = configuredDatabase({
    models: {},
    deploy: { target: 'vercel' },
    db: { local: ':memory:' },
  })
  const database = await provider.connect({ env: { NODE_ENV: 'development' }, request })
  expect(await database.get(sql`SELECT 1 AS value`)).toEqual({ value: 1 })
  expect(createRemoteClient).not.toHaveBeenCalled()
})

it('fails for missing Turso settings without falling back to D1 or local SQLite', async () => {
  const provider = configuredDatabase({ models: {}, deploy: { target: 'vercel' } })
  await expect(
    provider.connect({ env: { NODE_ENV: 'production', DB: {} }, request }),
  ).rejects.toThrow('Database requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN')
  expect(createRemoteClient).not.toHaveBeenCalled()
})

it('rejects file URLs in production before creating a libSQL client', async () => {
  const provider = configuredDatabase({ models: {}, deploy: { target: 'vercel' } })
  await expect(
    provider.connect({ env: { ...production, TURSO_DATABASE_URL: 'file:dev.db' }, request }),
  ).rejects.toThrow('local files are not persistent')
  expect(createRemoteClient).not.toHaveBeenCalled()
})

it('uses custom credentials and reconnects after a token rotation', async () => {
  const provider = configuredDatabase({
    models: {},
    db: { remote: { provider: 'turso', urlEnv: 'NOTES_URL', tokenEnv: 'NOTES_TOKEN' } },
  })
  const env = { NODE_ENV: 'production', NOTES_URL: 'https://notes.turso.io', NOTES_TOKEN: 'first' }
  const original = await provider.connect({ env, request })
  expect(await provider.connect({ env, request })).toBe(original)
  const rotated = await provider.connect({ env: { ...env, NOTES_TOKEN: 'rotated' }, request })
  expect(rotated).not.toBe(original)
  expect(createRemoteClient).toHaveBeenCalledTimes(2)
  expect(createRemoteClient).toHaveBeenLastCalledWith({ url: env.NOTES_URL, authToken: 'rotated' })
})
