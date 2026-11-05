import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { toRequest, type H3Event } from '../../nuxt/src/runtime/server/request.js'
import { defineBackend } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { compileConfig } from '../src/server/compile/index.js'
import { schemaStatements } from '../src/server/schema-sql.js'

const origin = 'https://cloudconfig.test'
const trustedOrigin = 'https://trusted.example'
const authEnv = {
  NODE_ENV: 'production',
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: 'test-only-signing-secret-with-more-than-32-characters',
}
const databases: Database.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function cloudflareEvent(headers: Record<string, string> = {}) {
  const iterate = vi.fn((): never => {
    throw new Error('Readable.asyncIterator is not implemented yet!')
  })
  const event: H3Event = {
    context: {},
    node: {
      req: {
        url: '/api/auth/sign-in/social',
        method: 'OPTIONS',
        headers: { host: 'cloudconfig.test', 'x-forwarded-proto': 'https', ...headers },
        [Symbol.asyncIterator]: iterate,
      },
    },
  }
  return { event, iterate }
}

function authBackend() {
  const config = defineBackend({
    models: {},
    auth: {
      emailPassword: true,
      devIdp: false,
      proxy: false,
      trustedOrigins: [trustedOrigin],
    },
  })
  const sqlite = new Database(':memory:')
  databases.push(sqlite)
  for (const entry of schemaStatements(compileConfig(config))) sqlite.exec(entry.sql)
  const database = drizzle(sqlite)
  return createBackend(config, { db: { id: 'test', connect: () => database } })
}

it.each([
  ['same-origin', origin],
  ['configured trusted', trustedOrigin],
  ['untrusted', 'https://untrusted.example'],
  ['missing', undefined],
])(
  'handles %s auth preflights without reading the Cloudflare Node stream',
  async (_, requestOrigin) => {
    const headers = {
      ...(requestOrigin ? { origin: requestOrigin } : {}),
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    }
    const { event, iterate } = cloudflareEvent(headers)
    const request = await toRequest(event)
    expect(request.method).toBe('OPTIONS')
    expect(request.body).toBeNull()
    expect(request.headers.get('origin')).toBe(requestOrigin ?? null)
    expect(request.headers.get('access-control-request-method')).toBe('POST')
    expect(iterate).not.toHaveBeenCalled()

    const response = await authBackend().fetch(request, authEnv)
    expect([204, 403, 404, 405]).toContain(response.status)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  },
)

it.each(['GET', 'HEAD', 'OPTIONS', 'PROPFIND'])(
  'does not read a Cloudflare Node body for %s',
  async (method) => {
    const { event, iterate } = cloudflareEvent()
    event.node!.req.method = method
    const request = await toRequest(event)
    expect(request.method).toBe(method)
    expect(request.body).toBeNull()
    expect(iterate).not.toHaveBeenCalled()
  },
)

it.each(['CONNECT', 'TRACE', 'TRACK'])(
  'rejects unsupported %s requests with 405',
  async (method) => {
    const { event, iterate } = cloudflareEvent()
    event.node!.req.method = method
    await expect(toRequest(event)).rejects.toMatchObject({ statusCode: 405 })
    expect(iterate).not.toHaveBeenCalled()
  },
)

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
  'preserves buffered %s bodies on the Cloudflare Node bridge',
  async (method) => {
    const { event, iterate } = cloudflareEvent({ 'content-type': 'application/json' })
    event.node!.req.method = method
    event.node!.req.body = Buffer.from('{"provider":"github"}')
    const request = await toRequest(event)
    expect(await request.json()).toEqual({ provider: 'github' })
    expect(iterate).not.toHaveBeenCalled()
  },
)

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
  'does not read absent %s bodies on the Cloudflare Node bridge',
  async (method) => {
    for (const headers of [{}, { 'content-length': '0' }]) {
      const { event, iterate } = cloudflareEvent(headers)
      event.node!.req.method = method
      event.node!.req.url = '/api/auth/__missing_empty_body_probe__'
      const request = await toRequest(event)
      expect(request.body).toBeNull()
      expect(iterate).not.toHaveBeenCalled()
      expect((await authBackend().fetch(request, authEnv)).status).toBe(404)
    }
  },
)

it('preserves chunked request bodies on a real Node stream', async () => {
  const { event } = cloudflareEvent({ 'transfer-encoding': 'chunked' })
  event.node!.req.method = 'POST'
  event.node!.req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from('{"provider":')
    yield Buffer.from('"github"}')
  }
  expect(await (await toRequest(event)).json()).toEqual({ provider: 'github' })
})
