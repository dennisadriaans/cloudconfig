import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { compileConfig } from '../src/server/compile/index.js'
import { schemaStatements } from '../src/server/schema-sql.js'
import { isDevelopment } from '../src/server/auth/env.js'

const databases: Database.Database[] = []
it('only enables the development identity provider in development', () => {
  expect(isDevelopment({ NODE_ENV: 'development' })).toBe(true)
  for (const value of ['production', 'staging', 'test', 'preview']) {
    expect(isDevelopment({ NODE_ENV: value })).toBe(false)
  }
})
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function backend(devIdp = false) {
  const config = defineBackend({
    auth: { emailPassword: true, devIdp, proxy: false },
    models: {
      note: model({ title: t.text() }, { access: { list: ({ user }) => user?.id === 1 } }),
    },
    access: { default: 'allow' },
  })
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  for (const entry of schemaStatements(compileConfig(config))) sqlite.exec(entry.sql)
  const db = drizzle(sqlite)
  return { app: createBackend(config, { db: { id: 'test', connect: () => db } }), sqlite }
}

it('starts development sign-in with a valid generic OAuth configuration', async () => {
  const { app } = backend(true)
  const response = await app.fetch(
    new Request('http://localhost/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ provider: 'dev', callbackURL: 'http://localhost/canvas' }),
    }),
    { NODE_ENV: 'development' },
  )
  expect(response.status, await response.clone().text()).toBe(200)
  const result = (await response.json()) as { url: string }
  expect(new URL(result.url).pathname).toBe('/api/auth/dev-idp/authorize')
})

it('keeps auth databases isolated when two backends share the same platform environment', async () => {
  const first = backend()
  const second = backend()
  const env = {
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: 'test-only-signing-secret-with-more-than-32-characters',
  }
  for (const [index, instance] of [first, second].entries()) {
    const response = await instance.app.fetch(
      new Request('http://localhost/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({
          name: `User ${index}`,
          email: `user${index}@example.com`,
          password: 'test-password-12345',
        }),
      }),
      env,
    )
    expect(response.status, await response.clone().text()).toBe(200)
    const result = (await response.json()) as { user: { id: unknown } }
    expect(typeof result.user.id).toBe('string')
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    expect((await instance.app.fetch(new Request('http://localhost/api/notes'), env)).status).toBe(
      403,
    )
    expect(
      (
        await instance.app.fetch(
          new Request('http://localhost/api/notes', { headers: { cookie } }),
          env,
        )
      ).status,
    ).toBe(200)
    expect(instance.sqlite.prepare('SELECT email FROM users').all()).toEqual([
      { email: `user${index}@example.com` },
    ])
    for (const table of ['users', 'sessions', 'accounts', 'verifications']) {
      expect(
        (await instance.app.fetch(new Request(`http://localhost/api/${table}`), env)).status,
      ).toBe(404)
    }
  }
  expect(first.sqlite.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 })
})
