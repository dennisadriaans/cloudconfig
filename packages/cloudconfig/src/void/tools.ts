import type { AnyConfig } from '../index.js'
import { d1 } from '../drivers/d1.js'
import {
  createAuthRuntime,
  compileConfig,
  createOperations,
  buildToolDefs,
  runTool,
  type ObjectStoreProvider,
  type OpResult,
  type RequestContext,
  type GetUser,
  type CloudConfigToolDef,
} from '../server/index.js'

export interface VoidToolOptions {
  getUser?: GetUser
  storage?: ObjectStoreProvider
}

export interface VoidBackendTool extends Pick<
  CloudConfigToolDef,
  'name' | 'description' | 'action' | 'schema' | 'inputSchema'
> {
  /** Invalid arguments return validation issues; model operations retain their access rules. */
  execute(args: unknown): Promise<OpResult<unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Generate provider-neutral tools for the current Void request or job.
 * Uses the public operations boundary: server-only fields never become tool inputs or results.
 * The host remains responsible for its model provider and review/approval policy.
 */
export function createVoidTools<C extends AnyConfig>(
  config: C,
  context: RequestContext,
  options: VoidToolOptions = {},
): VoidBackendTool[] {
  const compiled = compileConfig(config)
  const database = d1(config.db?.binding)
  const getUser =
    options.getUser ??
    (compiled.auth
      ? createAuthRuntime(compiled, compiled.auth, { db: database }).getUser
      : undefined)
  // Explicit ports prevent a caller from accidentally choosing server authority
  // or bypassing the D1 binding with options intended for a different adapter.
  const operations = createOperations(config, {
    db: database,
    ...(getUser ? { getUser } : {}),
    ...(options.storage ? { storage: options.storage } : {}),
  })

  return buildToolDefs(compiled).map((definition) => ({
    name: definition.name,
    description: definition.description,
    action: definition.action,
    schema: definition.schema,
    inputSchema: definition.inputSchema,
    async execute(args) {
      const parsed = definition.schema.safeParse(args)
      if (!parsed.success) {
        return {
          ok: false,
          code: 'validation',
          issues: parsed.error.issues.map(({ path, message }) => ({
            path: path.join('.'),
            message,
          })),
        }
      }
      if (!isRecord(parsed.data)) {
        throw new Error(`Generated tool ${definition.name} must accept an object.`)
      }
      return runTool(operations, context, definition, parsed.data)
    },
  }))
}
