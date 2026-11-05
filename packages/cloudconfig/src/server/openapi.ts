/** OpenAPI 3.1 for the public model REST API, derived from runtime validation. */
import { getTableColumns } from 'drizzle-orm'
import { z, type ZodType } from 'zod'
import { normalizeBasePath } from '../shared/project-config.js'
import { omitKeys } from '../shared/omit-keys.js'
import {
  publicModels,
  zodForField,
  type CompiledBase,
  type CompiledModel,
} from './compile/index.js'
import { DEFAULT_PAGE_SIZE, FILTER_OPERATORS, MAX_PAGE_SIZE } from './list-query.js'
import {
  AGGREGATE_INTERVALS,
  AGGREGATE_OPS,
  DEFAULT_AGGREGATE_LIMIT,
  MAX_AGGREGATE_LIMIT,
} from '../shared/aggregate.js'
import { RELATION_PROJECTION_KEYS } from './ports.js'
import { storageMapping, storagePath } from './storage.js'

type Schema = Record<string, unknown>
type Response = { description: string; content?: Record<string, { schema: Schema }> }
type Parameter = {
  name: string
  in: 'path' | 'query'
  required?: boolean
  description?: string
  schema?: Schema
  content?: { 'application/json': { schema: Schema } }
}
type Operation = {
  operationId: string
  tags: string[]
  summary: string
  description?: string
  parameters?: Parameter[]
  requestBody?: { required: boolean; content: Record<string, { schema: Schema }> }
  responses: Record<string, Response>
}

export interface OpenApiDocument {
  openapi: '3.1.1'
  info: { title: string; version: string; description: string }
  servers: Array<{ url: string }>
  tags: Array<{ name: string; description: string }>
  paths: Record<string, Partial<Record<'get' | 'post' | 'put' | 'patch' | 'delete', Operation>>>
  components: {
    schemas: Record<string, Schema>
    securitySchemes?: Record<
      string,
      { type: 'apiKey'; in: 'cookie'; name: string; description: string }
    >
  }
  security?: Array<Record<string, string[]>>
}

export interface OpenApiOptions {
  basePath?: string
  /** Disable when a custom getUser replaces the built-in session resolver. */
  sessionAuth?: boolean
}

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` })
const content = (schema: Schema) => ({ 'application/json': { schema } })
const response = (description: string, schema: Schema): Response => ({
  description,
  content: content(schema),
})

/** Rebase Zod's local JSON Schema references into this OpenAPI component. */
function component(schema: ZodType, name: string, io: 'input' | 'output'): Schema {
  const json = z.toJSONSchema(schema, { io, target: 'draft-2020-12' }) as Schema
  delete json['$schema']
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const object = value as Schema
    // The compiler also carries UI format hints; use JSON Schema's URI format
    // and let the JSON field's schema describe its values without a fake format.
    if (object['format'] === 'url') object['format'] = 'uri'
    if (object['format'] === 'json') delete object['format']
    if (typeof object['$ref'] === 'string' && object['$ref'].startsWith('#')) {
      object['$ref'] = `#/components/schemas/${name}${object['$ref'].slice(1)}`
    }
    // Visit schema keywords, not arbitrary data in defaults/examples or field
    // names that happen to be keywords themselves (e.g. a JSON field `default`).
    for (const key of ['properties', 'patternProperties', '$defs', 'dependentSchemas']) {
      const children = object[key]
      if (children && typeof children === 'object') Object.values(children).forEach(visit)
    }
    for (const key of [
      'allOf',
      'anyOf',
      'oneOf',
      'prefixItems',
      'items',
      'additionalProperties',
      'unevaluatedProperties',
      'contains',
      'propertyNames',
      'not',
      'if',
      'then',
      'else',
    ]) {
      visit(object[key])
    }
  }
  visit(json)
  return json
}

/** Include exactly the columns selected by the data adapter. */
function rowShape(model: CompiledModel, projection = false): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {}
  const foreignKeys = new Set(model.relationships.map((relation) => relation.fieldName))
  for (const [key, column] of Object.entries(getTableColumns(model.table))) {
    if (projection ? !RELATION_PROJECTION_KEYS.has(key) : foreignKeys.has(key)) continue
    const field = model.fieldSpecs[key]
    if (field?.spec.serverOnly) continue
    let schema: ZodType
    if (field) schema = zodForField(field.spec).nonoptional()
    else if (key === 'id') schema = z.number().int()
    else if (key === 'createdAt' || key === 'updatedAt') schema = z.iso.datetime()
    else if (column.dataType === 'number') schema = z.number()
    else if (column.dataType === 'boolean') schema = z.boolean()
    else if (column.dataType === 'json') schema = z.json()
    else schema = z.string()
    shape[key] = column.notNull ? schema : schema.nullable()
  }
  return shape
}

function rowSchema(base: CompiledBase, model: CompiledModel): ZodType {
  const shape = rowShape(model)
  for (const relation of model.relationships) {
    if (model.fieldSpecs[relation.fieldName]?.spec.serverOnly) continue
    const target = base.models[relation.targetModel]!
    // A left join can be null even for a required FK. Never recursively expose
    // the target model or internal auth columns outside the projection contract.
    shape[relation.relationKey] = z.object(rowShape(target, true)).nullable()
  }
  return z.object(shape)
}

function filterSchemas(): Record<string, Schema> {
  const scalarOperators = FILTER_OPERATORS.filter(
    (operator) => operator !== 'is_any_of' && operator !== 'is_none_of',
  )
  const condition = (operators: readonly string[], value: Schema): Schema => ({
    type: 'object',
    required: ['type', 'field', 'operator', 'value'],
    properties: {
      type: { type: 'string', const: 'condition' },
      field: {
        type: 'string',
        description: 'Column key, including relation keys such as authorId.',
      },
      operator: { type: 'string', enum: operators },
      value,
    },
  })
  return {
    FilterCondition: {
      oneOf: [
        condition(scalarOperators, { type: ['string', 'number', 'boolean', 'null'] }),
        condition(['is_any_of', 'is_none_of'], {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: { type: ['string', 'number'] },
        }),
      ],
    },
    FilterGroup: {
      type: 'object',
      required: ['type', 'logic', 'children'],
      description: 'At most 100 nodes and depth 8 (root depth 0); at most 20,000 JSON characters.',
      properties: {
        type: { type: 'string', const: 'group' },
        logic: { type: 'string', enum: ['and', 'or'] },
        children: {
          type: 'array',
          maxItems: 99,
          items: { oneOf: [ref('FilterCondition'), ref('FilterGroup')] },
        },
      },
    },
  }
}

function listParameters(model: CompiledModel): Parameter[] {
  const query = (name: string, schema: Schema, description?: string): Parameter => ({
    name,
    in: 'query',
    schema,
    ...(description ? { description } : {}),
  })
  return [
    query('page', { type: 'integer', minimum: 1, default: 1 }),
    query(
      'pageSize',
      {
        type: 'integer',
        minimum: 1,
        maximum: MAX_PAGE_SIZE,
        default: DEFAULT_PAGE_SIZE,
      },
      'Rows per page; values outside the range are clamped.',
    ),
    query('search', { type: 'string' }, 'Substring search across text columns.'),
    query(
      'sortBy',
      {
        type: 'string',
        enum: Object.keys(getTableColumns(model.table)).filter(
          (key) => !model.fieldSpecs[key]?.spec.serverOnly,
        ),
        default: 'id',
      },
      'Column key to sort by. Unknown columns fall back to id.',
    ),
    query('sortDir', { type: 'string', enum: ['asc', 'desc'], default: 'asc' }),
    {
      name: 'filters',
      in: 'query',
      description: 'A FilterGroup serialized as JSON and URL-encoded as one query parameter.',
      content: content(ref('FilterGroup')),
    },
  ]
}

function aggregateParameters(model: CompiledModel): Parameter[] {
  const query = (name: string, schema: Schema, description: string): Parameter => ({
    name,
    in: 'query',
    schema,
    description,
  })
  const columns = {
    type: 'string',
    enum: Object.keys(getTableColumns(model.table)).filter(
      (key) => !model.fieldSpecs[key]?.spec.serverOnly,
    ),
  }
  return [
    query('op', { type: 'string', enum: [...AGGREGATE_OPS], default: 'count' }, 'The reduction.'),
    query('field', columns, 'Column to reduce. Required except for count.'),
    query('groupBy', columns, 'Column to group by; a relation key also labels each group.'),
    query(
      'interval',
      { type: 'string', enum: [...AGGREGATE_INTERVALS] },
      'UTC period for a date groupBy; defaults to day.',
    ),
    query(
      'limit',
      {
        type: 'integer',
        minimum: 1,
        maximum: MAX_AGGREGATE_LIMIT,
        default: DEFAULT_AGGREGATE_LIMIT,
      },
      'Most groups returned; values outside the range are clamped.',
    ),
    {
      name: 'filters',
      in: 'query',
      description: 'A FilterGroup serialized as JSON and URL-encoded as one query parameter.',
      content: content(ref('FilterGroup')),
    },
  ]
}

const AGGREGATE_RESULT_SCHEMA = {
  type: 'object',
  required: ['value', 'buckets'],
  properties: {
    value: { type: ['number', 'null'] },
    buckets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'value'],
        properties: {
          key: { type: ['string', 'number', 'boolean', 'null'] },
          label: { type: 'string' },
          value: { type: ['number', 'null'] },
        },
      },
    },
  },
}

/** No database connection, auth lookup, or execution of access rules is needed. */
export function buildOpenApiDocument(
  base: CompiledBase,
  options: OpenApiOptions = {},
): OpenApiDocument {
  const models = publicModels(base)
  const schemas: Record<string, Schema> = {
    ...filterSchemas(),
    ApiError: component(
      z.object({
        error: z.string(),
        message: z.string(),
        issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
      }),
      'ApiError',
      'output',
    ),
  }
  const document: OpenApiDocument = {
    openapi: '3.1.1',
    info: {
      title: 'CloudConfig API',
      version: '1.0.0',
      description:
        'Generated public model REST API. Access rules are evaluated for every request; ' +
        'the presence of an operation does not grant access. Better Auth sign-in, administration, ' +
        'and custom application routes are separate APIs and are not included in this document.',
    },
    servers: [{ url: normalizeBasePath(options.basePath ?? base.basePath) }],
    tags: models.map((model) => ({ name: model.namePlural, description: model.label })),
    paths: {},
    components: { schemas },
  }

  if (options.sessionAuth ?? !!base.auth) {
    document.components.securitySchemes = {
      SessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'better-auth.session_token',
        description: 'Better Auth session cookie on HTTP.',
      },
      SecureSessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Secure-better-auth.session_token',
        description: 'Better Auth session cookie on HTTPS.',
      },
    }
    // Authentication is optional at the transport layer: arbitrary access-rule
    // functions decide which operations allow an anonymous or signed-in caller.
    document.security = [{}, { SessionCookie: [] }, { SecureSessionCookie: [] }]
  }

  for (const model of models) {
    // Encode punctuation, including underscores, without collisions or invalid
    // component-name characters. Model names need not be TS identifiers.
    const name = [...model.name]
      .map((char) => (/[A-Za-z0-9-]/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`))
      .join('')
    const createName = `Model.${name}.Create`
    const updateName = `Model.${name}.Update`
    const rowName = `Model.${name}.Row`
    const pageName = `Model.${name}.Page`
    const create = component(model.create, createName, 'input')
    schemas[createName] = create
    schemas[updateName] = component(model.update, updateName, 'input')
    schemas[rowName] = component(rowSchema(base, model), rowName, 'output')
    const properties = create['properties'] as Record<string, Schema>
    for (const { columnKey, spec } of Object.values(model.fieldSpecs)) {
      if (spec.hasDefault && properties[columnKey]) {
        properties[columnKey]['default'] = spec.defaultValue
      }
    }
    schemas[pageName] = {
      type: 'object',
      required: ['data', 'totalCount', 'page', 'pageSize', 'totalPages'],
      properties: {
        data: { type: 'array', items: ref(rowName) },
        totalCount: { type: 'integer', minimum: 0 },
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
        totalPages: { type: 'integer', minimum: 1 },
      },
    }
    const error = (description: string) => response(description, ref('ApiError'))
    const errors = { '500': error('Internal server or database error.') }
    const id: Parameter[] = [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
    ]
    const operation = (
      action: string,
      summary: string,
    ): Pick<Operation, 'operationId' | 'tags' | 'summary'> => ({
      operationId: `${name}_${action}`,
      tags: [model.namePlural],
      summary,
    })
    const update = (method: string): Operation => ({
      ...operation(method, `Update ${model.label}`),
      description:
        'Partial update. Omitted fields are unchanged; PUT has the same semantics as PATCH.',
      parameters: id,
      requestBody: { required: false, content: content(ref(updateName)) },
      responses: {
        '200': response('Updated record.', ref(rowName)),
        '400': error('Invalid id or input; validation errors include issues.'),
        '409': error('The record changed after validation; reload it before retrying.'),
        '404': error('Record not found or access denied.'),
        ...errors,
      },
    })
    document.paths[`/${model.namePlural}`] = {
      get: {
        ...operation('list', `List ${model.label}`),
        parameters: listParameters(model),
        responses: {
          '200': response('Paginated records.', ref(pageName)),
          '400': error('Invalid filters.'),
          '403': error('Access denied.'),
          ...errors,
        },
      },
      post: {
        ...operation('create', `Create ${model.label}`),
        requestBody: {
          required: Array.isArray(create['required']) && create['required'].length > 0,
          content: content(ref(createName)),
        },
        responses: {
          '201': response('Created record.', ref(rowName)),
          '400': error('Invalid input; validation errors include issues.'),
          '403': error('Access denied.'),
          ...errors,
        },
      },
    }
    document.paths[`/${model.namePlural}/aggregate`] = {
      get: {
        ...operation('aggregate', `Aggregate ${model.label}`),
        parameters: aggregateParameters(model),
        responses: {
          '200': response('The aggregate and its groups.', AGGREGATE_RESULT_SCHEMA),
          '400': error('Invalid query; validation errors include issues.'),
          '403': error('Access denied.'),
          ...errors,
        },
      },
    }
    document.paths[`/${model.namePlural}/{id}`] = {
      get: {
        ...operation('get', `Read ${model.label}`),
        parameters: id,
        responses: {
          '200': response('Record.', ref(rowName)),
          '400': error('Invalid id.'),
          '404': error('Record not found or access denied.'),
          ...errors,
        },
      },
      put: update('put'),
      patch: update('patch'),
      delete: {
        ...operation('delete', `Delete ${model.label}`),
        parameters: id,
        responses: {
          '204': { description: 'Record deleted. No response body.' },
          '400': error('Invalid id.'),
          '404': error('Record not found or access denied.'),
          ...errors,
        },
      },
    }
    if (model.model.options.storage) {
      const mapping = storageMapping(model)
      const metadata = omitKeys(properties, Object.values(mapping))
      const required = (create['required'] as string[] | undefined)?.filter(
        (key) => key in metadata,
      )
      const upload: Operation = {
        ...operation('upload', `Upload ${model.label}`),
        description:
          'Upload bytes and metadata together. Storage assigns the key, owner, MIME type and size.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file', ...(required?.length ? ['fields'] : [])],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  fields: {
                    type: 'string',
                    description: 'JSON-encoded metadata.',
                    contentMediaType: 'application/json',
                    contentSchema: {
                      type: 'object',
                      properties: metadata,
                      required,
                      additionalProperties: false,
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': response('Stored record.', ref(rowName)),
          '400': error('Invalid upload or metadata.'),
          '403': error('Access denied.'),
          '413': error('File too large.'),
          '415': error('File type not allowed.'),
          '503': error('Storage unavailable.'),
          ...errors,
        },
      }
      document.paths[`/${model.namePlural}`]!.post = upload
      document.paths[storagePath(model)] = {
        post: { ...upload, operationId: `${name}_uploadContent` },
      }
      document.paths[`${storagePath(model)}/{id}`] = {
        get: {
          ...operation('download', `Download ${model.label}`),
          parameters: id,
          responses: {
            '200': {
              description: 'Private file bytes.',
              content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            '404': error('File not found or access denied.'),
            ...errors,
          },
        },
        delete: {
          ...document.paths[`/${model.namePlural}/{id}`]!.delete!,
          operationId: `${name}_deleteContent`,
        },
      }
    }
  }
  return document
}
