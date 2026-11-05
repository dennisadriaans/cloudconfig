import Database from 'better-sqlite3'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { defineBackend, getFieldSpec, model, t } from '../src/index.js'
import { compileConfig, compileTables, schemaStatements } from '../src/server/index.js'

const config = defineBackend({
  models: {
    author: model({ name: t.text().required() }),
    post: model({
      title: t.text().required(),
      ownerId: t.number().required().serverOnly().index(),
      author: t.relation('author').index(),
      slug: t.text().unique().index(),
    }),
  },
})

function indexesOf(name: string) {
  return getTableConfig(compileTables(config)[name]!).indexes.map(({ config: entry }) => ({
    name: entry.name,
    unique: entry.unique,
    columns: entry.columns.map((column) => (column as { name: string }).name),
  }))
}

it('marks indexed fields without changing their other modifiers', () => {
  const field = t.number().required().serverOnly().index()
  expect(getFieldSpec(field)).toMatchObject({ indexed: true, required: true, serverOnly: true })
  expect(getFieldSpec(t.text())).not.toHaveProperty('indexed')
})

it('compiles indexed columns and relations, but not already unique ones', () => {
  expect(indexesOf('post')).toEqual([
    { name: 'posts_owner_id_idx', unique: false, columns: ['owner_id'] },
    { name: 'posts_author_id_idx', unique: false, columns: ['author_id'] },
  ])
  expect(indexesOf('author')).toEqual([])
})

it('creates the indexes for a schema rendered without migrations', () => {
  const sqlite = new Database(':memory:')
  for (const entry of schemaStatements(compileConfig(config))) sqlite.exec(entry.sql)
  const names = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'posts'`)
    .all()
    .map((row) => (row as { name: string }).name)
  expect(names).toEqual(expect.arrayContaining(['posts_owner_id_idx', 'posts_author_id_idx']))
  const plan = sqlite
    .prepare('EXPLAIN QUERY PLAN SELECT * FROM posts WHERE owner_id = ?')
    .all(1)
    .map((row) => (row as { detail: string }).detail)
  expect(plan.join('\n')).toContain('USING INDEX posts_owner_id_idx')
})

it('emits CREATE INDEX in generated migrations', async () => {
  const require = createRequire(import.meta.url)
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } =
    require('drizzle-kit/api') as typeof import('drizzle-kit/api')
  const empty = await generateSQLiteDrizzleJson({})
  const current = await generateSQLiteDrizzleJson(compileTables(config))
  const statements = (await generateSQLiteMigration(empty, current)).join('\n')
  expect(statements).toContain('CREATE INDEX `posts_owner_id_idx` ON `posts` (`owner_id`)')
  expect(statements).toContain('CREATE INDEX `posts_author_id_idx` ON `posts` (`author_id`)')
})
