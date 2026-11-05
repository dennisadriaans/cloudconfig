import { getTableColumns, getTableName } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { compileConfig, compileTables } from '../src/server/compile/index.js'
import { toFieldOverrides } from '../src/server/bridge.js'
import { ConfigError } from '../src/shared/errors.js'

const config = defineBackend({
  models: {
    user: model({
      name: t.text().required(),
      email: t.email().required().unique(),
    }),
    post: model({
      title: t.text().required(),
      body: t.textarea(),
      status: t.select(['draft', 'published']).default('draft'),
      views: t.number().default(0),
      author: t.relation('user'),
    }),
  },
})

describe('compileConfig — tables', () => {
  const compiled = compileConfig(config)

  it('names tables with the pluralized model key', () => {
    expect(getTableName(compiled.models.post!.table)).toBe('posts')
    expect(getTableName(compiled.models.user!.table)).toBe('users')
  })

  it('injects id + timestamp columns', () => {
    const cols = getTableColumns(compiled.models.post!.table)
    expect(cols['id']?.primary).toBe(true)
    expect(cols['createdAt']).toBeDefined()
    expect(cols['updatedAt']).toBeDefined()
  })

  it('maps a relation field to an authorId FK column with snake_case db name', () => {
    const cols = getTableColumns(compiled.models.post!.table)
    expect(cols['authorId']).toBeDefined()
    expect(cols['authorId']?.name).toBe('author_id')
    // the relation key itself is not a column
    expect(cols['author']).toBeUndefined()
  })

  it('records a belongs-to relationship with author relationKey', () => {
    const rel = compiled.models.post!.relationships
    expect(rel).toHaveLength(1)
    expect(rel[0]).toMatchObject({
      fieldName: 'authorId',
      relationKey: 'author',
      target: 'users',
      targetModel: 'user',
    })
  })

  it('marks required columns notNull and unique columns unique', () => {
    const cols = getTableColumns(compiled.models.user!.table)
    expect(cols['name']?.notNull).toBe(true)
    expect(cols['email']?.isUnique).toBe(true)
  })

  it('discovers inline foreign keys the way DashboardStack does', () => {
    const fkSymbol = Symbol.for('drizzle:SQLiteInlineForeignKeys')
    const table = compiled.models.post!.table
    const fks = Reflect.get(table, fkSymbol)
    expect(Array.isArray(fks)).toBe(true)
    expect(Array.isArray(fks) && fks.length).toBe(1)
  })

  it('is memoized', () => {
    expect(compileConfig(config)).toBe(compiled)
  })
})

describe('compileConfig — zod schemas', () => {
  const compiled = compileConfig(config)

  it('validates a well-formed create payload', () => {
    const result = compiled.models.post!.create.safeParse({
      title: 'Hello',
      authorId: 1,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a create payload missing a required field', () => {
    const result = compiled.models.post!.create.safeParse({ body: 'no title' })
    expect(result.success).toBe(false)
  })

  it('rejects an out-of-range select value', () => {
    const result = compiled.models.post!.create.safeParse({
      title: 'x',
      status: 'archived',
    })
    expect(result.success).toBe(false)
  })

  it('makes defaulted and optional fields omittable in create', () => {
    const result = compiled.models.post!.create.safeParse({ title: 'x' })
    expect(result.success).toBe(true)
  })

  it('produces a fully-partial update schema', () => {
    const result = compiled.models.post!.update.safeParse({})
    expect(result.success).toBe(true)
  })

  it('allows clearing nullable fields and relations without clearing required or defaulted fields', () => {
    const post = compiled.models.post!
    expect(post.update.parse({ body: null, authorId: null })).toEqual({
      body: null,
      authorId: null,
    })
    expect(post.serverUpdate!.parse({ body: null, authorId: null })).toEqual({
      body: null,
      authorId: null,
    })
    for (const key of ['title', 'status', 'views']) {
      expect(post.update.safeParse({ [key]: null }).success).toBe(false)
      expect(post.serverUpdate!.safeParse({ [key]: null }).success).toBe(false)
    }
    expect(post.create.safeParse({ title: 'Hello', authorId: null }).success).toBe(false)
  })
})

describe('compileTables', () => {
  it('returns one table per model keyed by singular name', () => {
    const tables = compileTables(config)
    expect(Object.keys(tables).sort()).toEqual(['post', 'user'])
  })
})

describe('toFieldOverrides', () => {
  it('maps field meta and relationship into DashboardStack override shape', () => {
    const compiled = compileConfig(config)
    const overrides = toFieldOverrides(compiled.models.post!)
    expect(overrides['status']?.options).toEqual(['draft', 'published'])
    expect(overrides['authorId']?.relationship).toEqual({
      model: 'User',
      resource: 'users',
      endpoint: '/api/users',
    })
  })
})

describe('compileConfig — validation errors', () => {
  it('rejects an unknown relation target', () => {
    const bad = defineBackend({
      models: { post: model({ author: t.relation('nope') }) },
    })
    expect(() => compileConfig(bad)).toThrow(ConfigError)
    expect(() => compileConfig(bad)).toThrow(/unknown model "nope"/)
  })

  it('rejects a reserved field name', () => {
    const bad = defineBackend({ models: { post: model({ id: t.text() }) } })
    expect(() => compileConfig(bad)).toThrow(/reserved/)
  })

  it('rejects an empty config', () => {
    const bad = defineBackend({ models: {} })
    expect(() => compileConfig(bad)).toThrow(/no models/)
  })

  it('accepts an auth-only config and compiles its internal tables', () => {
    const authOnly = defineBackend({
      models: {},
      auth: { providers: { github: true } },
    })

    const compiled = compileConfig(authOnly)

    expect(Object.keys(compiled.models)).toEqual(['user', 'session', 'account', 'verification'])
    expect(Object.values(compiled.models).every((entry) => entry.internal)).toBe(true)
    expect(Object.keys(compileTables(authOnly))).toEqual([
      'user',
      'session',
      'account',
      'verification',
    ])
  })

  it('compiles Better Auth organization tables when enabled', () => {
    const authOnly = defineBackend({
      models: {},
      auth: { organizations: true },
    })

    const compiled = compileConfig(authOnly)

    expect(Object.keys(compiled.models)).toEqual([
      'user',
      'session',
      'account',
      'verification',
      'organization',
      'member',
      'invitation',
    ])
    expect(Object.values(compiled.models).every((entry) => entry.internal)).toBe(true)
  })

  it('resolves circular relations', () => {
    const circular = defineBackend({
      models: {
        user: model({ name: t.text().required(), favoritePost: t.relation('post') }),
        post: model({ title: t.text().required(), author: t.relation('user') }),
      },
    })
    const compiled = compileConfig(circular)
    expect(getTableColumns(compiled.models.user!.table)['favoritePostId']).toBeDefined()
    expect(getTableColumns(compiled.models.post!.table)['authorId']).toBeDefined()
  })
})
