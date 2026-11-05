import { expectTypeOf, it } from 'vitest'
import { defineBackend, model, t, type InferCreate, type InferSelect } from '../src/index.js'

/**
 * A wide config (30 models, each with several fields and a relation) that keeps
 * the inference machinery honest about compile-time cost. If `tsc` time blows
 * up on this file, the mapped-type design in `index.ts` needs revisiting before
 * shipping — see risk #8 in the plan.
 */
const config = defineBackend({
  models: {
    m00: model({
      a: t.text().required(),
      b: t.number(),
      c: t.boolean().default(false),
      r: t.relation('m01'),
    }),
    m01: model({
      a: t.text().required(),
      b: t.number(),
      c: t.select(['x', 'y']).default('x'),
      r: t.relation('m02'),
    }),
    m02: model({ a: t.text().required(), b: t.float(), c: t.date(), r: t.relation('m03') }),
    m03: model({ a: t.text().required(), b: t.email(), c: t.url(), r: t.relation('m04') }),
    m04: model({ a: t.text().required(), b: t.textarea(), c: t.json(), r: t.relation('m05') }),
    m05: model({ a: t.text().required(), b: t.number(), c: t.datetime(), r: t.relation('m06') }),
    m06: model({
      a: t.text().required(),
      b: t.multiselect(['p', 'q']),
      c: t.boolean(),
      r: t.relation('m07'),
    }),
    m07: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m08') }),
    m08: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m09') }),
    m09: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m10') }),
    m10: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m11') }),
    m11: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m12') }),
    m12: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m13') }),
    m13: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m14') }),
    m14: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m15') }),
    m15: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m16') }),
    m16: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m17') }),
    m17: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m18') }),
    m18: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m19') }),
    m19: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m20') }),
    m20: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m21') }),
    m21: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m22') }),
    m22: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m23') }),
    m23: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m24') }),
    m24: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m25') }),
    m25: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m26') }),
    m26: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m27') }),
    m27: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m28') }),
    m28: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m29') }),
    m29: model({ a: t.text().required(), b: t.number(), c: t.text(), r: t.relation('m00') }),
  },
})

type Config = typeof config

it('infers wide configs without pathological types', () => {
  expectTypeOf<InferSelect<Config, 'm00'>['a']>().toEqualTypeOf<string>()
  expectTypeOf<InferSelect<Config, 'm01'>['c']>().toEqualTypeOf<'x' | 'y'>()
  expectTypeOf<InferCreate<Config, 'm00'>>().toMatchObjectType<{ rId?: number }>()
})
