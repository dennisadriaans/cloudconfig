import type { Field, RelationField } from './fields.js'
import type { AnyConfig } from './model-config.js'

type FieldsOf<C extends AnyConfig, N extends keyof C['models']> = C['models'][N]['fields']

type DataOf<F> = F extends { readonly [' data']?: infer D } ? D : never
type IsReq<F> = F extends Field<unknown, infer R, boolean, boolean> ? R : never
type HasDef<F> = F extends Field<unknown, boolean, infer D, boolean> ? D : never
type RelTargetOf<F> = F extends RelationField<infer TgtName, boolean, boolean> ? TgtName : never

/** Keys of a model whose fields are relations. */
type RelationKeys<C extends AnyConfig, N extends keyof C['models']> = {
  [K in keyof FieldsOf<C, N>]: FieldsOf<C, N>[K] extends RelationField<string, boolean, boolean>
    ? K
    : never
}[keyof FieldsOf<C, N>]

type PublicKeys<C extends AnyConfig, N extends keyof C['models']> = {
  [K in keyof FieldsOf<C, N>]: FieldsOf<C, N>[K] extends { readonly [' serverOnly']?: true }
    ? never
    : K
}[keyof FieldsOf<C, N>]

type NonRelationKeys<C extends AnyConfig, N extends keyof C['models']> = Exclude<
  keyof FieldsOf<C, N>,
  RelationKeys<C, N>
>

/** Server-injected columns present on every row. */
interface BaseColumns {
  id: number
  createdAt: string
  updatedAt: string
}

/**
 * A field's value in a selected row. Non-null when the field is required OR has
 * a default (a default guarantees a stored value); nullable otherwise.
 */
type SelectValue<F> =
  IsReq<F> extends true ? DataOf<F> : HasDef<F> extends true ? DataOf<F> : DataOf<F> | null

/** A flat row (no relation expansion) for a model. */
type ServerFlatRow<C extends AnyConfig, N extends keyof C['models']> = BaseColumns & {
  [K in keyof FieldsOf<C, N>]: SelectValue<FieldsOf<C, N>[K]>
}

export type FlatRow<C extends AnyConfig, N extends keyof C['models']> = BaseColumns & {
  [K in PublicKeys<C, N>]: SelectValue<FieldsOf<C, N>[K]>
}

/** Resolve a relation field's target model name if it is a valid model key. */
type ResolveTarget<C extends AnyConfig, F> =
  RelTargetOf<F> extends infer TgtName
    ? TgtName extends keyof C['models']
      ? TgtName
      : never
    : never

/**
 * The wire shape of a selected row. Each relation field `author` becomes a
 * nested object (a partial of the target's flat row, always at least `{ id }`),
 * and the raw FK column is omitted — matching DashboardStack's join select shape.
 */
export type InferServerSelect<C extends AnyConfig, N extends keyof C['models']> = BaseColumns & {
  [K in NonRelationKeys<C, N>]: SelectValue<FieldsOf<C, N>[K]>
} & {
  [K in RelationKeys<C, N>]:
    ({ id: number } & Partial<ServerFlatRow<C, ResolveTarget<C, FieldsOf<C, N>[K]>>>) | null
}

/** Whether a field is optional in a create payload (has default or not required). */
type CreateOptional<F> =
  IsReq<F> extends true
    ? F extends Field<unknown, boolean, infer HasDef, boolean>
      ? HasDef
      : false
    : true

type RequiredCreateKeys<C extends AnyConfig, N extends keyof C['models']> = {
  [K in keyof FieldsOf<C, N>]: CreateOptional<FieldsOf<C, N>[K]> extends true ? never : K
}[keyof FieldsOf<C, N>]

type OptionalCreateKeys<C extends AnyConfig, N extends keyof C['models']> = Exclude<
  keyof FieldsOf<C, N>,
  RequiredCreateKeys<C, N>
>

/** Remap a relation key `author` to its FK column `authorId`. */
type CreateKey<C extends AnyConfig, N extends keyof C['models'], K extends keyof FieldsOf<C, N>> =
  FieldsOf<C, N>[K] extends RelationField<string, boolean, boolean>
    ? K extends string
      ? `${K}Id`
      : K
    : K

/**
 * The create payload for a model. Relation fields are supplied as their FK
 * (`authorId: number`); fields with a default or that aren't required are optional.
 */
export type InferServerCreate<C extends AnyConfig, N extends keyof C['models']> = {
  [K in RequiredCreateKeys<C, N> as CreateKey<C, N, K>]: DataOf<FieldsOf<C, N>[K]>
} & {
  [K in OptionalCreateKeys<C, N> as CreateKey<C, N, K>]?: DataOf<FieldsOf<C, N>[K]>
}

export type InferSelect<C extends AnyConfig, N extends keyof C['models']> = BaseColumns & {
  [K in Extract<NonRelationKeys<C, N>, PublicKeys<C, N>>]: SelectValue<FieldsOf<C, N>[K]>
} & {
  [K in Extract<RelationKeys<C, N>, PublicKeys<C, N>>]:
    ({ id: number } & Partial<FlatRow<C, ResolveTarget<C, FieldsOf<C, N>[K]>>>) | null
}

export type InferCreate<C extends AnyConfig, N extends keyof C['models']> = {
  [K in Extract<RequiredCreateKeys<C, N>, PublicKeys<C, N>> as CreateKey<C, N, K>]: DataOf<
    FieldsOf<C, N>[K]
  >
} & {
  [K in Extract<OptionalCreateKeys<C, N>, PublicKeys<C, N>> as CreateKey<C, N, K>]?: DataOf<
    FieldsOf<C, N>[K]
  >
}

/** Partial writes can explicitly clear nullable fields and relations. */
export type InferUpdate<C extends AnyConfig, N extends keyof C['models']> = {
  [K in PublicKeys<C, N> as CreateKey<C, N, K>]?: SelectValue<FieldsOf<C, N>[K]>
}
