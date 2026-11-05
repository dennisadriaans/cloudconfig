import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { compileConfig } from '../src/server/compile/index.js'
import { schemaStatements } from '../src/server/schema-sql.js'

const databases: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
})

function setup() {
  const config = defineBackend({
    auth: { emailPassword: true, twoFactor: { passkey: false }, devIdp: true, proxy: false },
    models: { note: model({ title: t.text() }, { access: { list: ({ user }) => !!user } }) },
  })
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  for (const entry of schemaStatements(compileConfig(config))) sqlite.exec(entry.sql)
  const db = drizzle(sqlite)
  const app = createBackend(config, { db: { id: 'test', connect: () => db } })
  const env = {
    NODE_ENV: 'development',
    BETTER_AUTH_SECRET: 'test-only-signing-secret-with-more-than-32-characters',
  }
  const cookies = new Map<string, string>()
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  async function request(path: string, body?: unknown, status = 200) {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type':
            body instanceof URLSearchParams
              ? 'application/x-www-form-urlencoded'
              : 'application/json',
          cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        },
        ...(body === undefined
          ? {}
          : { body: body instanceof URLSearchParams ? body : JSON.stringify(body) }),
      }),
      env,
    )
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]!
      const index = pair.indexOf('=')
      cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    expect(response.status, await response.clone().text()).toBe(status)
    return response
  }
  function code() {
    const line = logs.mock.calls.at(-1)?.[0] as string
    const value = line?.match(/: (\d{6})$/)?.[1]
    expect(value).toBeDefined()
    return value!
  }
  async function enroll() {
    await request('/api/auth/sign-up/email', {
      name: 'Tester',
      email: 'tester@example.com',
      password: 'test-password-12345',
    })
    await request('/api/auth/two-factor/send-otp', {})
    const otp = code()
    expect(
      sqlite.prepare("SELECT value FROM verifications WHERE identifier LIKE '2fa-otp-%'").get(),
    ).not.toEqual({ value: `${otp}:0` })
    await request('/api/auth/two-factor/verify-otp', { code: otp })
    expect(await (await request('/api/auth/two-factor/status')).json()).toEqual({
      enabled: true,
      method: 'email',
      pending: false,
    })
    await request('/api/auth/sign-out', {})
    cookies.clear()
  }
  return { request, code, enroll, sqlite, cookies, app, env, logs }
}

it('enrolls email OTP and withholds API access until the sign-in challenge is verified', async () => {
  const { request, code, enroll } = setup()
  await request('/api/auth/two-factor/send-otp', {}, 401)
  await enroll()
  expect(
    await (
      await request('/api/auth/sign-in/email', {
        email: 'tester@example.com',
        password: 'test-password-12345',
      })
    ).json(),
  ).toEqual({ twoFactorRedirect: true, twoFactorMethods: ['otp'] })
  await request('/api/notes', undefined, 403)
  expect(await (await request('/api/auth/two-factor/status')).json()).toEqual({
    enabled: true,
    method: 'email',
    pending: true,
  })
  await request('/api/auth/two-factor/send-otp', {})
  const otp = code()
  await request('/api/auth/two-factor/verify-otp', { code: otp })
  await request('/api/notes')
  await request('/api/auth/two-factor/verify-otp', { code: otp }, 400)
  await request('/api/auth/two-factor/disable', { password: 'test-password-12345' })
  expect(await (await request('/api/auth/two-factor/status')).json()).toEqual({
    enabled: false,
    method: null,
    pending: false,
  })
})

it('gates the development OAuth callback until email verification completes', async () => {
  const { request, code, enroll } = setup()
  await enroll()
  const start = (await (
    await request('/api/auth/sign-in/social', { provider: 'dev', callbackURL: '/dashboard' })
  ).json()) as { url: string }
  const authorize = new URL(start.url)
  const picker = await request(
    authorize.pathname + authorize.search,
    new URLSearchParams({
      email: 'tester@example.com',
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      state: authorize.searchParams.get('state')!,
    }),
    302,
  )
  const callback = new URL(picker.headers.get('location')!)
  const response = await request(callback.pathname + callback.search, undefined, 302)
  expect(response.headers.get('location')).toBe('/two-factor')
  await request('/api/notes', undefined, 403)
  await request('/api/auth/two-factor/send-otp', {})
  await request('/api/auth/two-factor/verify-otp', { code: code() })
  await request('/api/notes')
})

it('returns a delivery error without logging OTPs in production', async () => {
  const { request, env, logs } = setup()
  env.NODE_ENV = 'production'
  await request('/api/auth/sign-up/email', {
    name: 'Tester',
    email: 'tester@example.com',
    password: 'test-password-12345',
  })
  const response = await request('/api/auth/two-factor/send-otp', {}, 502)
  expect(await response.text()).toContain('Email OTP requires')
  expect(logs).not.toHaveBeenCalled()
})

it('rejects stale enrollment and invalidates a challenge after five wrong codes even across resends', async () => {
  const { request, code, enroll, sqlite } = setup()
  await enroll()
  await request('/api/auth/sign-in/email', {
    email: 'tester@example.com',
    password: 'test-password-12345',
  })
  await request('/api/auth/two-factor/send-otp', {})
  const wrong = code() === '000000' ? '111111' : '000000'
  for (let i = 0; i < 5; i++) {
    await request('/api/auth/two-factor/verify-otp', { code: wrong }, 401)
    await request('/api/auth/two-factor/send-otp', {})
  }
  await request('/api/auth/two-factor/verify-otp', { code: code() }, 400)
  await request('/api/notes', undefined, 403)
  await request('/api/auth/two-factor/status', undefined, 401)
  await request('/api/auth/sign-in/email', {
    email: 'tester@example.com',
    password: 'test-password-12345',
  })
  await request('/api/auth/two-factor/send-otp', {})
  await request('/api/auth/two-factor/verify-otp', { code: code() })
  sqlite.prepare('UPDATE sessions SET created_at = ?').run(Math.floor(Date.now() / 1000) - 10 * 60)
  await request('/api/auth/two-factor/send-otp', {}, 401)
})
