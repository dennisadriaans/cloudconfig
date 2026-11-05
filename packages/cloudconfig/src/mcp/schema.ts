/**
 * JSON-serializable schema description for agents (MCP tools / docs).
 * Derived entirely from CompiledBase — never from drizzle objects.
 */
import { publicModels, type CompiledBase, type CompiledModel } from '../server/compile/index.js'
import { storagePath } from '../server/storage.js'

export interface SchemaFieldDesc {
  name: string
  kind: string
  required: boolean
  unique?: boolean
  default?: unknown
  options?: readonly string[]
  relation?: string
  label?: string
  description?: string
}

export interface SchemaModelDesc {
  name: string
  plural: string
  label: string
  path: string
  fields: SchemaFieldDesc[]
  endpoints: {
    list: string
    get: string
    create: string
    update: string
    delete: string
    upload?: string
    download?: string
  }
}

export interface SchemaDesc {
  basePath: string
  docs: boolean
  models: SchemaModelDesc[]
}

function describeModel(base: CompiledBase, model: CompiledModel): SchemaModelDesc {
  const path = `${base.basePath}/${model.namePlural}`
  const fields: SchemaFieldDesc[] = Object.values(model.fieldSpecs)
    .filter(({ spec }) => !spec.serverOnly)
    .map(({ columnKey, spec }) => {
      const field: SchemaFieldDesc = {
        name: columnKey,
        kind: spec.relation ? 'relation' : spec.kind,
        required: Boolean(spec.required),
      }
      if (spec.unique) field.unique = true
      if (spec.hasDefault) field.default = spec.defaultValue
      if (spec.options) field.options = spec.options
      if (spec.relation) field.relation = spec.relation.target
      if (spec.label) field.label = spec.label
      if (spec.description) field.description = spec.description
      return field
    })

  return {
    name: model.name,
    plural: model.namePlural,
    label: model.label,
    path,
    fields,
    endpoints: {
      list: `GET ${path}`,
      get: `GET ${path}/:id`,
      create: `POST ${path}`,
      update: `PATCH ${path}/:id`,
      delete: `DELETE ${path}/:id`,
      ...(model.model.options.storage
        ? {
            upload: `POST ${base.basePath}${storagePath(model)} (multipart/form-data)`,
            download: `GET ${base.basePath}${storagePath(model)}/:id`,
          }
        : {}),
    },
  }
}

/** Build a plain JSON schema description from a compiled base. */
export function describeSchema(base: CompiledBase): SchemaDesc {
  return {
    basePath: base.basePath,
    docs: base.docs,
    models: publicModels(base).map((model) => describeModel(base, model)),
  }
}
