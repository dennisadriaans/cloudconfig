import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { compileConfig } from '../src/server/compile/index.js'
import { createServerClient } from '../src/server/client.js'
import { schemaStatements } from '../src/server/schema-sql.js'
import type { Db, DbProvider } from '../src/server/driver.js'

const config = defineBackend({
  models: {
    note: model(
      { title: t.text().required(), ownerId: t.number().required().serverOnly() },
      {
        access: {
          list: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
          read: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
          create: ({ user, input }) => !!user && String(input?.title).startsWith('Allowed'),
          update: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
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

describe('can', () => {
  it('applies the same rule and row predicate as the matching operation without writing', async () => {
    const db = freshDb()
    const request = new Request('http://localhost/api/notes')
    const owner = createServerClient(config, { request, user: { id: 1 } }, { db })
    const other = createServerClient(config, { request, user: { id: 2 } }, { db })
    const note = await owner.note.create({ title: 'Allowed note', ownerId: 1 })

    expect(await owner.note.can('update', { id: note.id, input: { title: 'Renamed' } })).toBe(true)
    expect(await other.note.can('update', { id: note.id, input: { title: 'Renamed' } })).toBe(false)
    expect(await owner.note.can('update', { id: 999 })).toBe(false)
    expect(await owner.note.can('delete', { id: note.id })).toBe(false)
    expect(await owner.note.can('create', { input: { title: 'Denied' } })).toBe(false)
    expect(await owner.note.can('create', { input: { title: 'Allowed too' } })).toBe(true)
    expect(await owner.note.can('list')).toBe(true)
    expect((await owner.note.get(note.id)).title).toBe('Allowed note')
  })
})
