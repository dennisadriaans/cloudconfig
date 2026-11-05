/**
 * The compiler: turns the plain-data DSL config into the three things the
 * server needs — real drizzle tables, zod validation schemas, and field meta.
 *
 * This module lives under `cloudconfig/server`, the only place allowed to import
 * drizzle/zod. The DSL layer (`src/index.ts`) never reaches here.
 */
import { getTableColumns } from 'drizzle-orm'
import {
  index,
  integer,
  sqliteTable,
  text,
  type AnySQLiteColumn,
  type SQLiteColumnBuilderBase,
  type SQLiteTable,
} from 'drizzle-orm/sqlite-core'
import { z, type ZodType } from 'zod'
import type { AnyConfig, AnyModel, FieldSpec } from '../../index.js'
import { capitalize } from '../../shared/capitalize.js'
import { ConfigError } from '../../shared/errors.js'
import {
  pluralize,
  relationColumnKey,
  relationRecordKey,
  toSnakeCase,
} from '../../shared/pluralize.js'
import { normalizeBasePath } from '../../shared/project-config.js'
import { resolveAuth, type ResolvedAuth } from '../../shared/auth-resolve.js'
import { buildColumn } from './columns.js'
import { validateStorage, storageMapping, storagePath } from '../storage.js'
import { compileAuthModels } from './auth-tables.js'
import { compileConnectModels } from './connect-tables.js'
import { resolveConnect, type ResolvedConnect } from '../../shared/connect-resolve.js'

const RESERVED_FIELD_NAMES = new Set(['id', 'createdAt', 'updatedAt'])
const FIELD_NAME_RE = /^[a-z][A-Za-z0-9]*$/

/** A compiled model: the drizzle table plus everything derived from its fields. */
export interface CompiledModel {
  name: string
  namePlural: string
  label: string
  timestamps: boolean
  /**
   * Compiled and migrated, but never exposed: no REST route, no MCP tool, no
   * agent accessor, no docs entry. The auth tables are the only ones so far.
   */
  internal?: boolean
  table: SQLiteTable
  /** Column key → the field spec that produced it (relation keys are the FK column). */
  fieldSpecs: Record<string, CompiledField>
  relationships: CompiledRelationship[]
  create: ZodType
  update: ZodType
  serverCreate?: ZodType
  serverUpdate?: ZodType
  model: AnyModel
}

export interface CompiledField {
  /** The DB column key (e.g. `authorId` for a relation field `author`). */
  columnKey: string
  spec: FieldSpec
}

export interface CompiledRelationship {
  /** The FK column key, e.g. `authorId`. */
  fieldName: string
  /** The nested-object key, e.g. `author`. */
  relationKey: string
  /** The plural name of the target model, e.g. `users`. */
  target: string
  targetModel: string
}

export interface CompiledBase {
  models: Record<string, CompiledModel>
  /** Model name (singular key) → compiled model, for relation resolution. */
  basePath: string
  docs: boolean
  accessDefault: 'allow' | 'deny'
  /** Present when the config has a usable `auth` block. */
  auth?: ResolvedAuth
  /** Present when the config has a `connect` block. */
  connect?: ResolvedConnect
}

/**
 * The models a caller may reach — everything except the internal auth tables.
 * Every exposure surface (REST routing, MCP tools, the agent API, the docs
 * page) iterates this, never `base.models`.
 */
export function publicModels(base: CompiledBase): CompiledModel[] {
  return Object.values(base.models).filter((model) => !model.internal)
}

const cache = new WeakMap<AnyConfig, CompiledBase>()

/** Compile a config, memoized per config object. Throws `ConfigError` on invalid input. */
export function compileConfig(config: AnyConfig): CompiledBase {
  const cached = cache.get(config)
  if (cached) return cached
  const compiled = doCompile(config)
  cache.set(config, compiled)
  return compiled
}

/** Convenience for the drizzle-kit shim: just the tables. */
export function compileTables(config: AnyConfig): Record<string, SQLiteTable> {
  const compiled = compileConfig(config)
  const out: Record<string, SQLiteTable> = {}
  for (const [name, model] of Object.entries(compiled.models)) out[name] = model.table
  return out
}

function doCompile(config: AnyConfig): CompiledBase {
  const modelNames = Object.keys(config.models)
  // Auth first: its tables are relation targets for the app's own models, so
  // they have to be in the table map before pass 1 resolves a `t.relation('user')`.
  const auth = resolveAuth(config)
  if (modelNames.length === 0 && !auth) throw new ConfigError('config has no models')

  const authModels: Record<string, CompiledModel> = auth
    ? compileAuthModels(auth.userFields, {
        admin: !!auth.admin,
        organizations: !!auth.organizations,
        twoFactor: !!auth.twoFactor,
        passkey: !!auth.twoFactor && auth.twoFactor.passkey !== false,
        scim: !!auth.scim,
      })
    : {}
  const connect = resolveConnect(config)
  if (connect && authModels['user']) {
    Object.assign(
      authModels,
      compileConnectModels({
        user: authModels['user'].table,
        ...(authModels['organization'] ? { organization: authModels['organization'].table } : {}),
      }),
    )
  }
  const tables: Record<string, SQLiteTable> = {}
  const authTableNames = new Set(Object.values(authModels).map((model) => model.namePlural))
  for (const [name, model] of Object.entries(authModels)) {
    tables[name] = model.table
  }
  // Both the key and the table name matter: a model called `users` would
  // produce the same table as auth's `user` and silently redefine it.
  for (const name of modelNames) {
    if (authModels[name] || authTableNames.has(pluralize(name))) {
      throw new ConfigError(
        `model "${name}" collides with a table CloudConfig's auth owns (${[...authTableNames].join(', ')}). Rename the model, or drop the "auth" block.`,
      )
    }
  }

  // Pass 1: build every table. Relation columns close over `tables` via a lazy
  // thunk, so mutual references resolve once the record is fully populated.
  const known = new Set([...Object.keys(authModels), ...modelNames])
  for (const name of modelNames) {
    tables[name] = buildTable(name, config.models[name]!, known, tables)
  }

  // Pass 2: derive schemas, meta, relationships from the finished tables.
  const models: Record<string, CompiledModel> = { ...authModels }
  for (const name of modelNames) {
    models[name] = finishModel(name, config.models[name]!, tables[name]!)
    validateStorage(models[name]!)
  }
  const paths = new Set([
    '/_docs',
    '/openapi.json',
    ...Object.values(models).map((model) => `/${model.namePlural}`),
  ])
  for (const model of Object.values(models)) {
    if (!model.model.options.storage) continue
    const path = storagePath(model)
    if (paths.has(path)) {
      throw new ConfigError(`model "${model.name}": storage path "${path}" is already in use.`)
    }
    paths.add(path)
  }

  return {
    models,
    basePath: normalizeBasePath(config.server?.basePath),
    docs: config.server?.docs !== false,
    accessDefault: config.access?.default ?? 'deny',
    ...(auth ? { auth } : {}),
    ...(connect ? { connect } : {}),
  }
}

function buildTable(
  name: string,
  model: AnyModel,
  known: ReadonlySet<string>,
  tables: Record<string, SQLiteTable>,
): SQLiteTable {
  const timestamps = model.options.timestamps !== false
  const columns: Record<string, SQLiteColumnBuilderBase> = {
    id: integer('id').primaryKey({ autoIncrement: true }),
  }
  // Unique columns already carry an index; a second one would only cost writes.
  const indexed: string[] = []

  for (const [fieldName, field] of Object.entries(model.fields)) {
    assertValidFieldName(name, fieldName)
    const spec = field[' spec']
    if (spec.relation) {
      const columnKey = relationColumnKey(fieldName)
      const target = spec.relation.target
      if (!known.has(target)) {
        throw new ConfigError(
          `model "${name}": relation field "${fieldName}" targets unknown model "${target}". Known models: ${[...known].join(', ')}.`,
        )
      }
      let col = integer(toSnakeCase(columnKey)).references(
        (): AnySQLiteColumn => resolveIdColumn(tables[target]!),
        { onDelete: spec.relation.onDelete },
      )
      if (spec.required) col = col.notNull()
      columns[columnKey] = col
      if (spec.indexed && !spec.unique) indexed.push(columnKey)
    } else {
      columns[fieldName] = buildColumn(fieldName, spec)
      if (spec.indexed && !spec.unique) indexed.push(fieldName)
    }
  }

  if (timestamps) {
    columns['createdAt'] = text('created_at').notNull()
    columns['updatedAt'] = text('updated_at').notNull()
  }

  const tableName = pluralize(name)
  return sqliteTable(tableName, columns, (table) =>
    indexed.map((key) =>
      index(`${tableName}_${toSnakeCase(key)}_idx`).on(table[key] as AnySQLiteColumn),
    ),
  )
}

function resolveIdColumn(table: SQLiteTable): AnySQLiteColumn {
  const cols = getTableColumns(table)
  const id = cols['id']
  if (!id) throw new ConfigError('target table is missing an id column')
  return id
}

function assertValidFieldName(model: string, fieldName: string): void {
  if (RESERVED_FIELD_NAMES.has(fieldName)) {
    throw new ConfigError(
      `model "${model}": field name "${fieldName}" is reserved (id, createdAt, updatedAt are managed automatically).`,
    )
  }
  if (!FIELD_NAME_RE.test(fieldName)) {
    throw new ConfigError(
      `model "${model}": field name "${fieldName}" is invalid; must match ${FIELD_NAME_RE}.`,
    )
  }
}

function finishModel(name: string, model: AnyModel, table: SQLiteTable): CompiledModel {
  const timestamps = model.options.timestamps !== false
  const fieldSpecs: Record<string, CompiledField> = {}
  const relationships: CompiledRelationship[] = []
  const createShape: Record<string, ZodType> = {}
  const updateShape: Record<string, ZodType> = {}
  const serverShape: Record<string, ZodType> = {}
  const serverUpdateShape: Record<string, ZodType> = {}

  for (const [fieldName, field] of Object.entries(model.fields)) {
    const spec = field[' spec']
    const columnKey = spec.relation ? relationColumnKey(fieldName) : fieldName
    fieldSpecs[columnKey] = { columnKey, spec }

    if (spec.relation) {
      relationships.push({
        fieldName: columnKey,
        relationKey: relationRecordKey(fieldName),
        target: pluralize(spec.relation.target),
        targetModel: spec.relation.target,
      })
    }

    const fieldSchema = zodForField(spec)
    // Only nullable columns can be explicitly cleared in an update.
    const updateFieldSchema =
      !spec.required && !spec.hasDefault ? fieldSchema.nullable() : fieldSchema
    serverShape[columnKey] = fieldSchema
    serverUpdateShape[columnKey] = updateFieldSchema
    if (!spec.serverOnly) {
      createShape[columnKey] = fieldSchema
      updateShape[columnKey] = updateFieldSchema
    }
  }

  const shape = z.object(createShape)
  const hasServerOnly = Object.values(fieldSpecs).some(({ spec }) => spec.serverOnly)
  const create = hasServerOnly ? shape.strict() : shape
  const updateObject = z.object(updateShape)
  let update = (hasServerOnly ? updateObject.strict() : updateObject).partial()
  if (model.options.storage) {
    const mapping = storageMapping({ model })
    const managed = [
      mapping.key,
      mapping.owner,
      mapping.size,
      mapping.mimeType,
      ...(mapping.text ? [mapping.text] : []),
    ]
    update = z
      .strictObject(
        Object.fromEntries(Object.entries(updateShape).filter(([key]) => !managed.includes(key))),
      )
      .partial()
  }

  return {
    name,
    namePlural: pluralize(name),
    label: model.options.label ?? capitalize(name),
    timestamps,
    table,
    fieldSpecs,
    relationships,
    create,
    update,
    serverCreate: z.object(serverShape),
    serverUpdate: z.object(serverUpdateShape).partial(),
    model,
  }
}

/** Shared with the OpenAPI response schemas so field constraints stay in sync. */
export function zodForField(spec: FieldSpec): ZodType {
  const base = zodBase(spec)
  const withMeta = base.meta(fieldMeta(spec))
  // Required-and-undefaulted fields must be present in a create payload.
  // Everything else is omittable: optional fields obviously, and defaulted
  // fields because the default is applied server-side when absent.
  if (spec.required && !spec.hasDefault) return withMeta
  return withMeta.optional()
}

function zodBase(spec: FieldSpec): ZodType {
  switch (spec.kind) {
    case 'number':
      return z.number().int()
    case 'float':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'date':
      return z.iso.date()
    case 'datetime':
      return z.iso.datetime()
    case 'email':
      return z.email()
    case 'url':
      return z.url()
    case 'json':
      return z.json()
    case 'relation':
      return z.number().int()
    case 'select':
      return spec.options && spec.options.length > 0
        ? z.enum(toEnumTuple(spec.options))
        : z.string()
    case 'multiselect':
      return spec.options && spec.options.length > 0
        ? z.array(z.enum(toEnumTuple(spec.options)))
        : z.array(z.string())
    default:
      return z.string()
  }
}

function toEnumTuple(options: readonly string[]): [string, ...string[]] {
  const [first, ...rest] = options
  if (first === undefined) throw new ConfigError('select/multiselect requires at least one option')
  return [first, ...rest]
}

/** The UI/wire meta carried on a field — plain data, drizzle-free. */
export interface FieldMeta {
  // Index signature satisfies zod's `.meta()` global-registry param type.
  [key: string]: string | boolean | readonly string[] | undefined
  label?: string
  formField?: string
  tableCell?: string
  hidden?: boolean
  placeholder?: string
  description?: string
  options?: readonly string[]
  format?: string
}

function fieldMeta(spec: FieldSpec): FieldMeta {
  const meta: FieldMeta = {}
  if (spec.label !== undefined) meta.label = spec.label
  if (spec.formField !== undefined) meta.formField = spec.formField
  if (spec.tableCell !== undefined) meta.tableCell = spec.tableCell
  if (spec.hidden !== undefined) meta.hidden = spec.hidden
  if (spec.placeholder !== undefined) meta.placeholder = spec.placeholder
  if (spec.description !== undefined) meta.description = spec.description
  if (spec.options !== undefined) meta.options = spec.options
  const format = spec.meta?.['format']
  if (typeof format === 'string') meta.format = format
  return meta
}
