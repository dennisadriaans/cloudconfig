import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, f } from '../src/client/index.js'
import { defineBackend, model, t } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import type { Db, DbProvider } from '../src/server/driver.js'

const config = defineBackend({
  models: {
    user: model({ name: t.text().required(), email: t.email().required().unique() }),
    post: model({
      title: t.text().required(),
      status: t.select(['draft', 'published']).default('draft'),
      author: t.relation('user'),
    }),
  },
  access: { default: 'allow' },
})
type Config = typeof config

function freshDb(): DbProvider {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT DEFAULT 'draft', author_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `)
  const db: Db = drizzle(sqlite)
  return { id: 'test', connect: (): Db => db }
}

describe('client round-trip against createBackend', () => {
  let client: ReturnType<typeof createClient<Config>>

  beforeEach(() => {
    const app = createBackend(config, { db: freshDb() })
    // route the client's fetch through the in-memory app
    const appFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      return app.request(url, init)
    }
    client = createClient<Config>({ baseUrl: 'http://localhost/api', fetch: appFetch })
  })

  it('creates and lists', async () => {
    const user = await client.user.create({ name: 'Ada', email: 'ada@x.com' })
    expect(user.id).toBe(1)
    const post = await client.post.create({ title: 'Hello', authorId: 1 })
    expect(post.status).toBe('draft')

    const list = await client.post.list()
    expect(list.totalCount).toBe(1)
    expect(list.data[0]?.author).toMatchObject({ id: 1, name: 'Ada' })
  })

  it('updates and deletes', async () => {
    await client.user.create({ name: 'Ada', email: 'ada@x.com' })
    const updated = await client.user.update(1, { name: 'Ada L.' })
    expect(updated.name).toBe('Ada L.')
    await client.user.delete(1)
    await expect(client.user.get(1)).rejects.toThrow()
  })

  it('sends a typed filter', async () => {
    await client.user.create({ name: 'Ada', email: 'ada@x.com' })
    await client.post.create({ title: 'D', authorId: 1, status: 'draft' })
    await client.post.create({ title: 'P', authorId: 1, status: 'published' })
    const published = await client.post.list({
      filters: f.and(f.where<Config, 'post'>('status', 'eq', 'published')),
    })
    expect(published.totalCount).toBe(1)
    expect(published.data[0]?.title).toBe('P')
  })
})

/**
 * Server-side runtimes (Next server components, Nitro) run `fetch` in Node,
 * which rejects relative URLs — so a relative `baseUrl` must be resolved
 * against an absolute origin before the request goes out.
 */
describe('baseUrl resolution on the server', () => {
  const SERVER_ENV = ['CLOUDCONFIG_URL', 'NEXT_PUBLIC_SITE_URL', 'VERCEL_URL', 'PORT'] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(SERVER_ENV.map((k) => [k, process.env[k]]))
    for (const key of SERVER_ENV) delete process.env[key]
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  /** Capture the URL the client actually fetches. */
  async function urlFor(baseUrl?: string): Promise<string> {
    let seen = ''
    const spyFetch: typeof fetch = async (input) => {
      seen = typeof input === 'string' ? input : input.toString()
      return new Response('{"data":[],"totalCount":0}', {
        headers: { 'content-type': 'application/json' },
      })
    }
    const opts = baseUrl === undefined ? { fetch: spyFetch } : { baseUrl, fetch: spyFetch }
    await createClient<Config>(opts).post.list()
    return seen
  }

  it('defaults to localhost:3000 with no env', async () => {
    expect(await urlFor()).toBe('http://localhost:3000/api/posts')
  })

  it('honours PORT', async () => {
    process.env['PORT'] = '4000'
    expect(await urlFor()).toBe('http://localhost:4000/api/posts')
  })

  it('prefers CLOUDCONFIG_URL over every other signal', async () => {
    process.env['CLOUDCONFIG_URL'] = 'https://app.example.com'
    process.env['NEXT_PUBLIC_SITE_URL'] = 'https://ignored.example.com'
    process.env['VERCEL_URL'] = 'ignored.vercel.app'
    process.env['PORT'] = '4000'
    expect(await urlFor()).toBe('https://app.example.com/api/posts')
  })

  it('falls back to NEXT_PUBLIC_SITE_URL', async () => {
    process.env['NEXT_PUBLIC_SITE_URL'] = 'https://site.example.com'
    expect(await urlFor()).toBe('https://site.example.com/api/posts')
  })

  it('adds the scheme Vercel omits from VERCEL_URL', async () => {
    process.env['VERCEL_URL'] = 'my-app.vercel.app'
    expect(await urlFor()).toBe('https://my-app.vercel.app/api/posts')
  })

  it('strips a trailing slash on the configured origin', async () => {
    process.env['CLOUDCONFIG_URL'] = 'https://app.example.com/'
    expect(await urlFor()).toBe('https://app.example.com/api/posts')
  })

  it('leaves an absolute baseUrl untouched', async () => {
    process.env['CLOUDCONFIG_URL'] = 'https://ignored.example.com'
    expect(await urlFor('http://localhost:9999/api')).toBe('http://localhost:9999/api/posts')
  })
})
