import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { compileConfig } from '../src/server/compile/index.js'
import { schemaStatements } from '../src/server/schema-sql.js'

const ENV = {
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 'test-only-signing-secret-with-more-than-32-characters',
}
const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function setup() {
  const config = defineBackend({
    auth: {
      emailPassword: true,
      devIdp: false,
      proxy: false,
      organizations: true,
      scim: true,
    },
    models: { note: model({ title: t.text() }) },
  })
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  const base = compileConfig(config)
  for (const entry of schemaStatements(base)) sqlite.exec(entry.sql)
  const db = drizzle(sqlite)
  const app = createBackend(config, { db: { id: 'test', connect: () => db } })
  const call = (path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (!headers.has('origin')) headers.set('origin', 'http://localhost')
    if (init.cookie) headers.set('cookie', init.cookie)
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }), ENV)
  }
  return { base, sqlite, call }
}

function cookiesOf(current: string, response: Response) {
  const jar = new Map(
    current
      .split('; ')
      .filter(Boolean)
      .map((entry) => [entry.split('=')[0]!, entry] as const),
  )
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0]!
    jar.set(pair.split('=')[0]!, pair)
  }
  return [...jar.values()].join('; ')
}

async function owner(harness: ReturnType<typeof setup>) {
  const signUp = await harness.call('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ada', email: 'ada@acme.test', password: 'test-password-12345' }),
  })
  let cookie = cookiesOf('', signUp)
  const created = await harness.call('/api/auth/organization/create', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
  })
  expect(created.status, await created.clone().text()).toBe(200)
  const organization = (await created.json()) as { id: string }
  cookie = cookiesOf(cookie, created)
  const active = await harness.call('/api/auth/organization/set-active', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ organizationId: organization.id }),
  })
  return { cookie: cookiesOf(cookie, active), organizationId: Number(organization.id) }
}

it('compiles the SCIM tables as internal models', async () => {
  const harness = setup()
  for (const name of ['scimToken', 'scimIdentity']) {
    expect(harness.base.models[name]?.internal, name).toBe(true)
  }
  expect((await harness.call('/api/scimTokens')).status).toBe(404)
})

it('provisions and deprovisions organization members over SCIM', async () => {
  const harness = setup()
  const { cookie, organizationId } = await owner(harness)
  expect((await harness.call('/api/auth/scim-connections', { method: 'POST' })).status).toBe(401)
  const created = await harness.call('/api/auth/scim-connections', {
    method: 'POST',
    cookie,
    body: '{}',
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const secret = (await created.json()) as {
    token: string
    baseUrl: string
    credential: Record<string, unknown>
  }
  expect(secret.baseUrl).toBe('http://localhost/api/auth/scim/v2')
  expect(Object.keys(secret.credential).sort()).toEqual([
    'createdAt',
    'expiresAt',
    'label',
    'lastUsedAt',
    'revokedAt',
    'uid',
  ])
  expect((await harness.call('/api/auth/scim/v2/Users', { bearer: 'scim_wrong' })).status).toBe(401)

  const user = await harness.call('/api/auth/scim/v2/Users', {
    method: 'POST',
    bearer: secret.token,
    headers: { 'content-type': 'application/scim+json' },
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'dana@acme.test',
      name: { givenName: 'Dana', familyName: 'Scully' },
      emails: [{ value: 'dana@acme.test', primary: true, type: 'work' }],
      active: true,
    }),
  })
  expect(user.status, await user.clone().text()).toBe(201)
  const { id } = (await user.json()) as { id: string }
  const membership = () =>
    harness.sqlite
      .prepare(
        "SELECT members.role FROM members JOIN users ON users.id = members.user_id WHERE users.email = 'dana@acme.test' AND members.organization_id = ?",
      )
      .all(organizationId)
  expect(membership()).toEqual([{ role: 'member' }])
  const found = (await (
    await harness.call(
      `/api/auth/scim/v2/Users?filter=${encodeURIComponent('userName eq "dana@acme.test"')}`,
      {
        bearer: secret.token,
      },
    )
  ).json()) as { totalResults: number; Resources: { id: string }[] }
  expect(found).toMatchObject({ totalResults: 1, Resources: [{ id }] })
  const pastTheEnd = (await (
    await harness.call('/api/auth/scim/v2/Users?startIndex=2&count=10', { bearer: secret.token })
  ).json()) as { totalResults: number; itemsPerPage: number }
  expect(pastTheEnd).toMatchObject({ totalResults: 1, itemsPerPage: 0 })
  const duplicate = await harness.call('/api/auth/scim/v2/Users', {
    method: 'POST',
    bearer: secret.token,
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'dana@acme.test',
    }),
  })
  expect(duplicate.status).toBe(409)

  const deactivated = await harness.call(`/api/auth/scim/v2/Users/${id}`, {
    method: 'PATCH',
    bearer: secret.token,
    headers: { 'content-type': 'application/scim+json' },
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }),
  })
  expect(deactivated.status, await deactivated.clone().text()).toBe(200)
  expect(membership()).toEqual([])
  // The owner is never removed by a directory, and a revoked token stops working.
  const owners = harness.sqlite.prepare("SELECT role FROM members WHERE role = 'owner'").all()
  expect(owners).toHaveLength(1)
  const tokens = (await (await harness.call('/api/auth/scim-connections', { cookie })).json()) as {
    tokens: { uid: string }[]
  }
  await harness.call('/api/auth/scim-connections/revoke', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ id: tokens.tokens[0]!.uid }),
  })
  expect(
    (await harness.call(`/api/auth/scim/v2/Users/${id}`, { bearer: secret.token })).status,
  ).toBe(401)
})
