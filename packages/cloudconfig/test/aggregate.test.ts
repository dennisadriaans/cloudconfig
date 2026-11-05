import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { createServerClient } from '../src/server/client.js'
import { compileConfig } from '../src/server/compile/index.js'
import { buildOpenApiDocument } from '../src/server/openapi.js'
import { schemaStatements } from '../src/server/schema-sql.js'
import type { Db, DbProvider } from '../src/server/driver.js'

const config = defineBackend({
  access: { default: 'allow' },
  models: {
    customer: model({ name: t.text().required(), secret: t.text().serverOnly() }),
    order: model(
      {
        customer: t.relation('customer').required(),
        status: t.select(['open', 'paid']).required(),
        total: t.float().required(),
        placedOn: t.date(),
        paid: t.boolean(),
        notes: t.textarea(),
        ownerId: t.number().required().serverOnly(),
      },
      {
        timestamps: true,
        access: {
          list: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
          create: () => true,
        },
      },
    ),
  },
})

function freshDb(): DbProvider {
  const sqlite = new Database(':memory:')
  for (const entry of schemaStatements(compileConfig(config))) sqlite.exec(entry.sql)
  const db: Db = drizzle(sqlite)
  return { id: 'test', connect: (): Db => db }
}

const request = new Request('http://localhost/api/orders')

async function seeded() {
  const db = freshDb()
  const server = createServerClient(config, { request, user: { id: 1 } }, { db })
  const acme = await server.customer.create({ name: 'Acme' })
  const globex = await server.customer.create({ name: 'Globex' })
  const rows = [
    { customerId: acme.id, status: 'paid', total: 10, placedOn: '2026-01-05', ownerId: 1 },
    { customerId: acme.id, status: 'paid', total: 20, placedOn: '2026-01-11', ownerId: 1 },
    { customerId: globex.id, status: 'open', total: 5, placedOn: '2026-01-12', ownerId: 1 },
    { customerId: globex.id, status: 'open', total: 1, placedOn: '2026-02-01', ownerId: 1 },
    { customerId: globex.id, status: 'paid', total: 1000, placedOn: '2026-02-01', ownerId: 2 },
  ] as const
  for (const row of rows) await server.order.create({ ...row, paid: row.status === 'paid' })
  return { db, server, app: createBackend(config, { db, getUser: () => ({ id: 1 }) }) }
}

describe('aggregate', () => {
  it('reduces only the rows the list rule allows', async () => {
    const { server } = await seeded()

    await expect(server.order.aggregate()).resolves.toEqual({ value: 4, buckets: [] })
    await expect(server.order.aggregate({ op: 'sum', field: 'total' })).resolves.toMatchObject({
      value: 36,
    })
    await expect(server.order.aggregate({ op: 'avg', field: 'total' })).resolves.toMatchObject({
      value: 9,
    })
    await expect(server.order.aggregate({ op: 'max', field: 'total' })).resolves.toMatchObject({
      value: 20,
    })
  })

  it('answers empty sets with zero for sums and null otherwise', async () => {
    const { server } = await seeded()
    const filters = {
      type: 'group' as const,
      logic: 'and' as const,
      children: [
        { type: 'condition' as const, field: 'status', operator: 'eq' as const, value: 'none' },
      ],
    }

    await expect(server.order.aggregate({ op: 'sum', field: 'total', filters })).resolves.toEqual({
      value: 0,
      buckets: [],
    })
    await expect(server.order.aggregate({ op: 'avg', field: 'total', filters })).resolves.toEqual({
      value: null,
      buckets: [],
    })
  })

  it('groups by value, largest first', async () => {
    const { server } = await seeded()

    await expect(
      server.order.aggregate({ op: 'sum', field: 'total', groupBy: 'status' }),
    ).resolves.toEqual({
      value: 36,
      buckets: [
        { key: 'paid', value: 30 },
        { key: 'open', value: 6 },
      ],
    })
    await expect(server.order.aggregate({ groupBy: 'paid' })).resolves.toMatchObject({
      buckets: [
        { key: false, value: 2 },
        { key: true, value: 2 },
      ],
    })
  })

  it('labels relation groups with the target title', async () => {
    const { server } = await seeded()
    const { buckets } = await server.order.aggregate({
      op: 'sum',
      field: 'total',
      groupBy: 'customer',
    })

    expect(buckets.map(({ label, value }) => [label, value])).toEqual([
      ['Acme', 30],
      ['Globex', 6],
    ])
  })

  it('buckets dates into UTC periods, oldest first', async () => {
    const { server } = await seeded()
    const buckets = async (interval: 'day' | 'week' | 'month') =>
      (await server.order.aggregate({ groupBy: 'placedOn', interval })).buckets

    await expect(buckets('month')).resolves.toEqual([
      { key: '2026-01', value: 3 },
      { key: '2026-02', value: 1 },
    ])
    await expect(buckets('week')).resolves.toEqual([
      { key: '2026-01-05', value: 2 },
      { key: '2026-01-12', value: 1 },
      { key: '2026-01-26', value: 1 },
    ])
    await expect(server.order.aggregate({ groupBy: 'placedOn' })).resolves.toMatchObject({
      buckets: [{ key: '2026-01-05' }, { key: '2026-01-11' }, { key: '2026-01-12' }, {}],
    })
  })

  it('keeps the latest periods within the limit and totals every row', async () => {
    const { server } = await seeded()

    await expect(
      server.order.aggregate({ groupBy: 'placedOn', interval: 'month', limit: 1 }),
    ).resolves.toEqual({ value: 4, buckets: [{ key: '2026-02', value: 1 }] })
  })

  it('groups by the model timestamps', async () => {
    const { server } = await seeded()
    const { buckets } = await server.order.aggregate({ groupBy: 'createdAt', interval: 'day' })

    expect(buckets.reduce((total, { value }) => total + (value ?? 0), 0)).toBe(4)
  })

  it('serves REST next to the id route and validates the query', async () => {
    const { app } = await seeded()
    const get = (query: string) => app.request(`/api/orders/aggregate${query}`)

    expect(await (await get('?op=sum&field=total')).json()).toEqual({ value: 36, buckets: [] })
    expect((await get('?op=median')).status).toBe(400)
    expect((await get('?op=sum')).status).toBe(400)
    expect((await get('?op=sum&field=status')).status).toBe(400)
    expect((await get('?groupBy=customerId')).status).toBe(200)
    expect((await get('?groupBy=notes')).status).toBe(400)
    expect((await get('?groupBy=status&interval=month')).status).toBe(400)
    expect((await get('?interval=month')).status).toBe(400)
  })

  it('refuses private columns from public callers', async () => {
    const { app } = await seeded()
    const filters = encodeURIComponent(
      JSON.stringify({
        type: 'group',
        logic: 'and',
        children: [{ type: 'condition', field: 'ownerId', operator: 'eq', value: 2 }],
      }),
    )

    for (const query of ['?groupBy=ownerId', '?op=sum&field=ownerId', `?filters=${filters}`]) {
      expect((await app.request(`/api/orders/aggregate${query}`)).status).toBe(400)
    }
  })

  it('denies callers the list rule denies', async () => {
    const db = freshDb()
    const app = createBackend(config, { db, getUser: () => null })

    expect((await app.request('/api/orders/aggregate')).status).toBe(403)
  })

  it('documents the route without private columns', () => {
    const document = buildOpenApiDocument(compileConfig(config))
    const parameters = document.paths['/orders/aggregate']?.get?.parameters

    expect(JSON.stringify(parameters)).toContain('customerId')
    expect(JSON.stringify(parameters)).not.toContain('ownerId')
  })
})
