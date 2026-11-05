import { describe, expectTypeOf, it } from 'vitest'
import {
  defineBackend,
  model,
  t,
  type InferCreate,
  type InferSelect,
  type InferUpdate,
} from '../src/index.js'

// A config exercising every inference concern: required/optional/default,
// select unions, and mutual (circular) relations between user and post.
const config = defineBackend({
  models: {
    user: model({
      name: t.text().required(),
      email: t.email().required().unique(),
      bio: t.textarea(),
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

type Config = typeof config

describe('InferSelect', () => {
  it('includes server-injected base columns', () => {
    expectTypeOf<InferSelect<Config, 'post'>['id']>().toEqualTypeOf<number>()
    expectTypeOf<InferSelect<Config, 'post'>['createdAt']>().toEqualTypeOf<string>()
    expectTypeOf<InferSelect<Config, 'post'>['updatedAt']>().toEqualTypeOf<string>()
  })

  it('makes required fields non-null and optional fields nullable', () => {
    expectTypeOf<InferSelect<Config, 'post'>['title']>().toEqualTypeOf<string>()
    expectTypeOf<InferSelect<Config, 'post'>['body']>().toEqualTypeOf<string | null>()
  })

  it('narrows a select field to its option union', () => {
    expectTypeOf<InferSelect<Config, 'post'>['status']>().toEqualTypeOf<'draft' | 'published'>()
  })

  it('expands a relation field into a nested object and omits the FK column', () => {
    type Row = InferSelect<Config, 'post'>
    expectTypeOf<Row['author']>().not.toBeNever()
    // nested object is nullable and carries at least an id
    expectTypeOf<NonNullable<Row['author']>['id']>().toEqualTypeOf<number>()
    // the raw FK column is not present on the selected row
    expectTypeOf<Row>().not.toHaveProperty('authorId')
  })
})

describe('InferCreate', () => {
  it('requires fields that are required and have no default', () => {
    expectTypeOf<InferCreate<Config, 'post'>>().toHaveProperty('title')
    expectTypeOf<InferCreate<Config, 'post'>['title']>().toEqualTypeOf<string>()
  })

  it('makes defaulted fields optional', () => {
    // status has a default, so it is optional in create
    expectTypeOf<InferCreate<Config, 'post'>>().toMatchObjectType<{
      status?: 'draft' | 'published'
    }>()
  })

  it('makes non-required fields optional', () => {
    expectTypeOf<InferCreate<Config, 'post'>>().toMatchObjectType<{ body?: string }>()
  })

  it('remaps a relation field to its FK column', () => {
    expectTypeOf<InferCreate<Config, 'post'>>().toMatchObjectType<{ authorId?: number }>()
    // the relation key itself is not part of the create payload
    expectTypeOf<InferCreate<Config, 'post'>>().not.toHaveProperty('author')
  })
})

describe('InferUpdate', () => {
  it('keeps required fields typed and permits clearing nullable fields and relations', () => {
    expectTypeOf<InferUpdate<Config, 'post'>['title']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<InferUpdate<Config, 'post'>['body']>().toEqualTypeOf<string | null | undefined>()
    expectTypeOf<InferUpdate<Config, 'post'>['authorId']>().toEqualTypeOf<
      number | null | undefined
    >()
  })
})

describe('circular relations', () => {
  it('resolves mutual references without an infinite type', () => {
    const circular = defineBackend({
      models: {
        user: model({
          name: t.text().required(),
          favoritePost: t.relation('post'),
        }),
        post: model({
          title: t.text().required(),
          author: t.relation('user'),
        }),
      },
    })
    type C = typeof circular
    expectTypeOf<InferCreate<C, 'user'>>().toMatchObjectType<{ favoritePostId?: number }>()
    expectTypeOf<InferCreate<C, 'post'>>().toMatchObjectType<{ authorId?: number }>()
    expectTypeOf<NonNullable<InferSelect<C, 'post'>['author']>['id']>().toEqualTypeOf<number>()
  })
})
