/**
 * The tool vocabulary a CloudConfig project exposes to an AI agent — one
 * definition per model operation, derived from the compiled config.
 *
 * Two transports render these: `server/mcp.ts` publishes them over the Model
 * Context Protocol, and `agents/tools.ts` hands them to a model as AI SDK tools
 * inside a Cloudflare Agent. Both must show an agent the *same* tool names and
 * the same input shapes, or a project's behavior would depend on which door the
 * agent came through — so the names, descriptions, and schemas live here, once.
 *
 * Every definition carries both a zod schema (what the AI SDK wants) and the
 * JSON Schema derived from it (what MCP puts on the wire), so the two views can
 * never drift apart.
 *
 * These definitions add no authority: `runTool` calls the same transport-neutral
 * operations core as REST, so validation, access rules, and hooks all apply.
 */
import { z, type ZodType } from 'zod'
import { describeSchema, type SchemaDesc } from '../mcp/schema.js'
import { publicModels, type CompiledBase, type CompiledModel } from './compile/index.js'
import type { OpResult, Operations, RequestContext } from './operations.js'
import type { ListQuery } from './ports.js'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './list-query.js'
import { storagePath, storageMapping } from './storage.js'

/** JSON-Schema-ish object, as MCP's `tools/list` carries it. */
export type JsonSchema = Record<string, unknown>

export type ToolAction =
  'list' | 'get' | 'create' | 'update' | 'delete' | 'describe' | 'upload' | 'download'

export interface CloudConfigToolDef {
  name: string
  description: string
  action: ToolAction
  /** Absent for model-independent tools such as `describe_schema`. */
  model?: CompiledModel
  /** The input contract, as zod. */
  schema: ZodType
  /** The same contract as JSON Schema, for transports that speak it. */
  inputSchema: JsonSchema
}

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './list-query.js'

const LIST_SCHEMA = z.strictObject({
  page: z.number().int().min(1).describe('1-based page number (default 1).').optional(),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .describe(`Rows per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).`)
    .optional(),
  search: z.string().describe('Free-text search across searchable fields.').optional(),
  sortBy: z.string().describe('Field name to sort by (defaults to id).').optional(),
  sortDir: z.enum(['asc', 'desc']).describe('Sort direction (default asc).').optional(),
  filters: z
    .looseObject({})
    .describe('A FilterGroup: { type: "group", logic: "and" | "or", children: [...] }.')
    .optional(),
})

function idSchema(description: string): ZodType {
  return z.strictObject({ id: z.number().int().describe(description) })
}

/** Turn a zod schema into the bare object JSON Schema MCP expects. */
export function toInputSchema(schema: ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input' }) as JsonSchema
  // MCP inputSchema is a bare object schema; drop the $schema dialect marker.
  delete json['$schema']
  if (json['type'] !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  return json
}

/** `model.update` plus the required `id` that says which row to patch. */
function updateSchema(model: CompiledModel, description: string): ZodType {
  const id = z.number().int().describe(description)
  if (model.update instanceof z.ZodObject) return model.update.extend({ id })
  return z.intersection(z.object({ id }), model.update)
}

/**
 * Build the tool set for a compiled config: `describe_schema` plus five tools
 * per model (`posts_list`, `posts_get`, `posts_create`, `posts_update`,
 * `posts_delete`).
 */
export function buildToolDefs(base: CompiledBase): CloudConfigToolDef[] {
  // Schema first: it is the tool an agent should reach for to orient itself.
  const describeInput = z.strictObject({})
  const defs: CloudConfigToolDef[] = [
    {
      name: 'describe_schema',
      description:
        'Describe the whole project: every model with its fields, types and REST endpoints, as derived from cloud.config.ts.',
      action: 'describe',
      schema: describeInput,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]

  for (const model of publicModels(base)) {
    const plural = model.namePlural
    const one = model.name
    const getInput = idSchema(`The id of the ${one} to fetch.`)
    const deleteInput = idSchema(`The id of the ${one} to delete.`)
    const patchInput = updateSchema(model, `The id of the ${one} to update.`)

    defs.push(
      {
        name: `${plural}_list`,
        description: `List ${model.label} records (paginated). Supports search, sort, and filters.`,
        action: 'list',
        model,
        schema: LIST_SCHEMA,
        inputSchema: toInputSchema(LIST_SCHEMA),
      },
      {
        name: `${plural}_get`,
        description: `Get a single ${one} by id.`,
        action: 'get',
        model,
        schema: getInput,
        inputSchema: toInputSchema(getInput),
      },
      {
        name: `${plural}_create`,
        description: `Create a new ${one}.`,
        action: 'create',
        model,
        schema: model.create,
        inputSchema: toInputSchema(model.create),
      },
      {
        name: `${plural}_update`,
        description: `Update an existing ${one} by id. Only include the fields you want to change.`,
        action: 'update',
        model,
        schema: patchInput,
        inputSchema: toInputSchema(patchInput),
      },
      {
        name: `${plural}_delete`,
        description: `Delete a ${one} by id.`,
        action: 'delete',
        model,
        schema: deleteInput,
        inputSchema: toInputSchema(deleteInput),
      },
    )
  }

  return defs.flatMap((tool) => {
    if (tool.action !== 'create' || !tool.model?.model.options.storage) return [tool]
    const model = tool.model
    const mapping = storageMapping(model)
    const managed = new Set([
      mapping.name,
      mapping.mimeType,
      mapping.size,
      mapping.key,
      mapping.owner,
      ...(mapping.text ? [mapping.text] : []),
    ])
    const shape = model.create instanceof z.ZodObject ? model.create.shape : {}
    const metadata = z.strictObject(
      Object.fromEntries(Object.entries(shape).filter(([key]) => !managed.has(key))),
    )
    const schema = z.strictObject({
      name: z.string().min(1),
      mimeType: z.string().optional(),
      content: z
        .string()
        .max(Math.ceil((model.model.options.storage!.maxSize ?? 25 * 1024 * 1024) / 3) * 4)
        .describe('Base64-encoded file bytes.'),
      fields: metadata,
    })
    const download = idSchema('The file id to download.')
    return [
      {
        ...tool,
        name: `${model.namePlural}_upload`,
        action: 'upload' as const,
        description: `Upload bytes and create ${model.label} metadata through the storage lifecycle.`,
        schema,
        inputSchema: toInputSchema(schema),
      },
      {
        ...tool,
        name: `${model.namePlural}_download`,
        action: 'download' as const,
        description:
          'Get an authenticated download URL. The URL requires the same session or credentials as the model API.',
        schema: download,
        inputSchema: toInputSchema(download),
      },
    ]
  })
}

/**
 * Run one tool against the operations core. Returns the transport-neutral
 * `OpResult` so each transport maps failures into its own vocabulary (HTTP
 * status, MCP `isError`, a tool-result string the model reads).
 */
export async function runTool(
  ops: Operations,
  ctx: RequestContext,
  tool: CloudConfigToolDef,
  args: Record<string, unknown>,
): Promise<OpResult<unknown>> {
  if (tool.action === 'describe') {
    const value: SchemaDesc = describeSchema(ops.base)
    return Promise.resolve({ ok: true, value })
  }

  const plural = tool.model!.namePlural
  switch (tool.action) {
    case 'list':
      return ops.list(ctx, plural, listQueryFrom(args))
    case 'get':
      return ops.get(ctx, plural, args['id'])
    case 'create':
      return ops.create(ctx, plural, args)
    case 'update': {
      const { id, ...patch } = args
      return ops.update(ctx, plural, id, patch)
    }
    case 'delete':
      return ops.remove(ctx, plural, args['id'])
    case 'upload': {
      try {
        const binary = atob(String(args['content'] ?? ''))
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        return ops.upload(ctx, plural, {
          file: new File([bytes], String(args['name'] ?? ''), {
            type: String(args['mimeType'] ?? 'application/octet-stream'),
          }),
          fields: args['fields'],
        })
      } catch {
        return {
          ok: false,
          code: 'validation',
          issues: [{ path: 'content', message: 'Provide valid base64 file content.' }],
        }
      }
    }
    case 'download': {
      const result = await ops.download(ctx, plural, args['id'])
      if (!result.ok) return result
      if (result.value.body instanceof ReadableStream) await result.value.body.cancel()
      return {
        ok: true,
        value: {
          url: `${ops.base.basePath === '/' ? '' : ops.base.basePath}${storagePath(tool.model!)}/${args['id']}`,
          name: result.value.name,
          mimeType: result.value.mimeType,
          size: result.value.size,
        },
      }
    }
  }
}

/** Normalize loose tool args into a `ListQuery`, mirroring `parseListParams`. */
export function listQueryFrom(args: Record<string, unknown>): ListQuery {
  const page = Math.max(1, toInt(args['page'], 1))
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, toInt(args['pageSize'], DEFAULT_PAGE_SIZE)))
  const search =
    typeof args['search'] === 'string' && args['search'].trim() ? args['search'].trim() : undefined
  const sortBy = typeof args['sortBy'] === 'string' && args['sortBy'] ? args['sortBy'] : undefined
  const sortDir = args['sortDir'] === 'desc' ? 'desc' : 'asc'
  const filters = normalizeFilters(args['filters'])
  return {
    page,
    pageSize,
    sortDir,
    ...(search !== undefined ? { search } : {}),
    ...(sortBy !== undefined ? { sortBy } : {}),
    ...(filters !== undefined ? { filters } : {}),
  }
}

function toInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

/** Accept a FilterGroup object (or its JSON string), ignoring anything malformed. */
function normalizeFilters(raw: unknown): ListQuery['filters'] {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === 'group' &&
    'children' in value &&
    Array.isArray((value as { children: unknown }).children)
  ) {
    const group = value as { logic?: unknown; children: unknown[] }
    return {
      type: 'group',
      logic: group.logic === 'or' ? 'or' : 'and',
      children: group.children as never,
    }
  }
  return undefined
}
