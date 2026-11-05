import { expectTypeOf, it } from 'vitest'
import { createClient, f, type PagedResult } from '../src/client/index.js'
import { defineBackend, model, t, type InferSelect } from '../src/index.js'

const config = defineBackend({
  models: {
    user: model({ name: t.text().required(), email: t.email().required() }),
    post: model({
      title: t.text().required(),
      status: t.select(['draft', 'published']).default('draft'),
      author: t.relation('user'),
      // Chained: the phantom relation target must survive the builder chain,
      // or the FK remap and the nested select shape silently disappear.
      editor: t.relation('user').required().label('Editor'),
    }),
  },
})
type Config = typeof config

const client = createClient<Config>()

it('exposes a client per model', () => {
  expectTypeOf(client.post).toHaveProperty('list')
  expectTypeOf(client.user).toHaveProperty('create')
})

it('types list results as PagedResult of the select row', () => {
  expectTypeOf(client.post.list).returns.resolves.toEqualTypeOf<
    PagedResult<InferSelect<Config, 'post'>>
  >()
})

it('types create input with the FK remap', () => {
  expectTypeOf(client.post.create).parameter(0).toMatchObjectType<{ authorId?: number }>()
})

it('keeps the FK remap through a chained relation', () => {
  expectTypeOf(client.post.create).parameter(0).toMatchObjectType<{ editorId: number }>()
})

it('selects a chained relation as a nested object, not a raw id', () => {
  expectTypeOf<NonNullable<InferSelect<Config, 'post'>['editor']>>().toMatchObjectType<{
    id: number
  }>()
  expectTypeOf<InferSelect<Config, 'post'>['editor']>().not.toBeNumber()
})

it('rejects an unknown sortBy field', () => {
  // @ts-expect-error 'nope' is not a column of post
  void client.post.list({ sortBy: 'nope' })
})

it('accepts a valid sortBy field', () => {
  void client.post.list({ sortBy: 'title', sortDir: 'desc' })
})

it('types f.where field against the model columns', () => {
  // @ts-expect-error 'missing' is not a column of post
  void f.where<Config, 'post'>('missing', 'eq', 'x')
  void f.where<Config, 'post'>('status', 'eq', 'published')
})
