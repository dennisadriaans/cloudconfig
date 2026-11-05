import {
  defineBackend,
  model,
  t,
  type InferCreate,
  type InferSelect,
  type InferServerSelect,
} from '../src/index.js'
import { expectTypeOf } from 'vitest'

const config = defineBackend({
  models: {
    person: model({ name: t.text().required(), email: t.email().serverOnly().required() }),
    note: model({
      title: t.text().required(),
      ownerId: t.number().required().serverOnly(),
      author: t.relation('person').required(),
    }),
  },
})
type PublicRow = InferSelect<typeof config, 'note'>
type ServerRow = InferServerSelect<typeof config, 'note'>
expectTypeOf<InferCreate<typeof config, 'note'>>().toMatchObjectType<{
  title: string
  authorId: number
}>()
expectTypeOf<InferCreate<typeof config, 'note'>>().not.toHaveProperty('ownerId')
expectTypeOf<ServerRow['ownerId']>().toEqualTypeOf<number>()
expectTypeOf<NonNullable<ServerRow['author']>['email']>().toEqualTypeOf<string | undefined>()
// @ts-expect-error Private fields are absent from browser responses.
type PublicOwner = PublicRow['ownerId']
// @ts-expect-error Relation expansion also removes private target fields.
type PublicEmail = NonNullable<PublicRow['author']>['email']
