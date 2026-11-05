import type { FieldKind, FieldSpec, OnDelete } from './field-spec.js'

/** Key under which the accumulated spec is exposed to the compiler. */
export const FIELD_SPEC_KEY = ' spec'

/**
 * A field in the DSL.
 *
 * @typeParam TData - the TypeScript value type this field holds.
 * @typeParam TReq  - phantom: whether `.required()` was called.
 * @typeParam TDef  - phantom: whether `.default()` was called.
 *
 * Every chain method returns a NEW field object (immutable), so specs never
 * alias. The `TData`/`TReq`/`TDef` generics drive `InferSelect`/`InferCreate`.
 */
export interface Field<
  TData,
  TReq extends boolean = false,
  TDef extends boolean = false,
  TServer extends boolean = false,
> {
  readonly [FIELD_SPEC_KEY]: FieldSpec
  /** Preserve the data type for inference; NoInfer on default() cannot carry it. */
  readonly [' data']?: TData
  readonly [' serverOnly']?: TServer
  required(): Field<TData, true, TDef, TServer>
  unique(): Field<TData, TReq, TDef, TServer>
  /** Index the column, for fields that list queries and access rules filter on. */
  index(): Field<TData, TReq, TDef, TServer>
  default(value: NoInfer<TData>): Field<TData, TReq, true, TServer>
  label(text: string): Field<TData, TReq, TDef, TServer>
  hidden(): Field<TData, TReq, TDef, TServer>
  serverOnly(): Field<TData, TReq, TDef, true>
  formField(id: string): Field<TData, TReq, TDef, TServer>
  tableCell(id: string): Field<TData, TReq, TDef, TServer>
  placeholder(text: string): Field<TData, TReq, TDef, TServer>
  describe(text: string): Field<TData, TReq, TDef, TServer>
}

/**
 * A belongs-to relation field. Carries the target model key as a phantom
 * literal so config-level inference can look up the target's row type.
 *
 * Every chain method is re-declared to return a `RelationField`. Inheriting
 * `Field`'s signatures would erase the phantom target on the first `.required()`
 * or `.label()`, and the field would silently infer as a plain `number` — a
 * create payload keyed `author` instead of `authorId`, and a selected row with
 * no nested object. The runtime spec was always right; only the types drifted.
 */
export interface RelationField<
  TTarget extends string,
  TReq extends boolean = false,
  TServer extends boolean = false,
> extends Field<number, TReq, false, TServer> {
  readonly [' target']: TTarget
  required(): RelationField<TTarget, true, TServer>
  unique(): RelationField<TTarget, TReq, TServer>
  index(): RelationField<TTarget, TReq, TServer>
  label(text: string): RelationField<TTarget, TReq, TServer>
  hidden(): RelationField<TTarget, TReq, TServer>
  serverOnly(): RelationField<TTarget, TReq, true>
  formField(id: string): RelationField<TTarget, TReq, TServer>
  tableCell(id: string): RelationField<TTarget, TReq, TServer>
  placeholder(text: string): RelationField<TTarget, TReq, TServer>
  describe(text: string): RelationField<TTarget, TReq, TServer>
}

/** A field of any shape — used where the concrete generics don't matter. */
export type AnyField = Field<unknown, boolean, boolean, boolean>

export function getFieldSpec(field: AnyField): FieldSpec {
  return field[FIELD_SPEC_KEY]
}

function makeField<
  TData,
  TReq extends boolean,
  TDef extends boolean,
  TServer extends boolean = false,
>(spec: FieldSpec): Field<TData, TReq, TDef, TServer> {
  const next = <D, R extends boolean, F extends boolean, S extends boolean = TServer>(
    patch: Partial<FieldSpec>,
  ): Field<D, R, F, S> => makeField<D, R, F, S>({ ...spec, ...patch })

  return {
    [FIELD_SPEC_KEY]: spec,
    required: () => next<TData, true, TDef>({ required: true }),
    unique: () => next<TData, TReq, TDef>({ unique: true }),
    index: () => next<TData, TReq, TDef>({ indexed: true }),
    default: (value) => next<TData, TReq, true>({ hasDefault: true, defaultValue: value }),
    label: (text) => next<TData, TReq, TDef>({ label: text }),
    hidden: () => next<TData, TReq, TDef>({ hidden: true }),
    serverOnly: () => next<TData, TReq, TDef, true>({ serverOnly: true }),
    formField: (id) => next<TData, TReq, TDef>({ formField: id }),
    tableCell: (id) => next<TData, TReq, TDef>({ tableCell: id }),
    placeholder: (text) => next<TData, TReq, TDef>({ placeholder: text }),
    describe: (text) => next<TData, TReq, TDef>({ description: text }),
  }
}

function baseSpec(kind: FieldKind, formField: string, extra?: Partial<FieldSpec>): FieldSpec {
  return { kind, required: false, unique: false, hasDefault: false, formField, ...extra }
}

/** At least one option — the shape `z.enum` and the select widgets require. */
type Options = readonly [string, ...string[]]

/** Field constructors. Each returns a fresh immutable builder. */
export const t = {
  text: (): Field<string> => makeField(baseSpec('text', 'text')),
  textarea: (): Field<string> => makeField(baseSpec('textarea', 'textarea')),
  number: (): Field<number> => makeField(baseSpec('number', 'number')),
  float: (): Field<number> => makeField(baseSpec('float', 'float')),
  boolean: (): Field<boolean> => makeField(baseSpec('boolean', 'boolean')),
  date: (): Field<string> => makeField(baseSpec('date', 'date')),
  datetime: (): Field<string> => makeField(baseSpec('datetime', 'datetime')),
  email: (): Field<string> => makeField(baseSpec('email', 'text', { meta: { format: 'email' } })),
  url: (): Field<string> => makeField(baseSpec('url', 'text', { meta: { format: 'url' } })),
  json: (): Field<unknown> => makeField(baseSpec('json', 'textarea', { meta: { format: 'json' } })),
  select: <const O extends Options>(options: O): Field<O[number]> =>
    makeField(baseSpec('select', 'select', { options })),
  multiselect: <const O extends Options>(options: O): Field<O[number][]> =>
    makeField(baseSpec('multiselect', 'multiselect', { options })),
  relation: <const T extends string>(target: T, opts?: { onDelete?: OnDelete }): RelationField<T> =>
    makeRelationField<T, false>(
      baseSpec('relation', 'relationship', {
        relation: { target, onDelete: opts?.onDelete ?? 'restrict' },
      }),
      target,
    ),
}

/**
 * A relation field whose chain methods stay relations. Each one delegates to the
 * plain builder for the spec change, then re-attaches the target — so the
 * phantom survives `.required().label('Author')` and the create/select types
 * keep their FK remap.
 */
function makeRelationField<T extends string, TReq extends boolean, TServer extends boolean = false>(
  spec: FieldSpec,
  target: T,
): RelationField<T, TReq, TServer> {
  const base = makeField<number, TReq, false, TServer>(spec)
  const rewrap = <R extends boolean, S extends boolean>(
    next: Field<number, R, false, S>,
  ): RelationField<T, R, S> => makeRelationField<T, R, S>(getFieldSpec(next), target)

  return {
    ...base,
    [' target']: target,
    required: () => rewrap(base.required()),
    unique: () => rewrap(base.unique()),
    index: () => rewrap(base.index()),
    label: (text) => rewrap(base.label(text)),
    hidden: () => rewrap(base.hidden()),
    serverOnly: () => rewrap(base.serverOnly()),
    formField: (id) => rewrap(base.formField(id)),
    tableCell: (id) => rewrap(base.tableCell(id)),
    placeholder: (text) => rewrap(base.placeholder(text)),
    describe: (text) => rewrap(base.describe(text)),
  }
}
