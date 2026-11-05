/**
 * createMcpServer — the MCP transport adapter. A sibling to `backend.ts`: where
 * that file adapts the transport-neutral operations core to HTTP/Hono, this one
 * adapts the *same* core to the Model Context Protocol so an agent (Claude Code,
 * Claude Desktop, …) can manage the backend through tool calls instead of REST.
 *
 * Every domain behavior — validation, access rules, hooks, persistence — still
 * lives in `operations.ts`. This module only maps tool calls to op calls and
 * `OpResult` codes to MCP tool results. It adds no new authority.
 *
 * The tool vocabulary itself (names, descriptions, input schemas, and the
 * mapping from a tool call to an operations call) lives in `tool-defs.ts`, so
 * a second transport can render the same tools without redefining them.
 *
 * The generated tools, per model `post` (plural `posts`):
 *   posts_list    — list with page / pageSize / search / sortBy / sortDir / filters
 *   posts_get     — read one by id
 *   posts_create  — create (input schema derived from the model's create schema)
 *   posts_update  — update one by id
 *   posts_delete  — delete one by id
 *
 * Plus one model-independent tool:
 *   describe_schema — the whole project surface (models, fields, REST endpoints)
 *     in a single call, so an agent can orient itself without reading every
 *     per-model tool schema.
 *
 * Identity (auth):
 *   Fail-closed, and never inferred. Exactly one identity mode must be declared:
 *   `getUser` resolves every caller from its own request (headers, validated MCP
 *   bearer token), `principal` pins a fixed service identity, `allowAnonymous`
 *   opts into unauthenticated access. The latter two are process-local only —
 *   `connect` rejects any transport that is not stdio or in-memory, so a network
 *   transport cannot serve as a fixed or anonymous principal.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  type CallToolResult,
  McpError,
  type RequestInfo,
  type ServerNotification,
  type ServerRequest,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { z, type ZodRawShape } from 'zod'
import type { AnyConfig } from '../index.js'
import type { DbProvider } from './driver.js'
import {
  createOperations,
  type OpErrorCode,
  type OpErrorReason,
  type Operations,
  type OpResult,
  type RequestContext,
  type ValidationIssue,
} from './operations.js'
import type { DataProvider, GetUser } from './ports.js'
import { buildToolDefs, runTool, toInputSchema, type CloudConfigToolDef } from './tool-defs.js'

/** An application tool, validated and dispatched by the CloudConfig MCP host. */
export interface McpExtensionTool {
  name: string
  description: string
  schema: z.ZodType
  annotations?: ToolAnnotations
  /** Explicitly allow a diagnostic tool before caller identity is available. */
  public?: boolean
  handle: (args: unknown, context: RequestContext) => Promise<CallToolResult> | CallToolResult
}

/** Collect typed application tools without depending on an MCP SDK server instance. */
export function createMcpToolRegistry() {
  const tools: McpExtensionTool[] = []
  return {
    tools,
    registerTool<Shape extends ZodRawShape>(
      name: string,
      definition: {
        description: string
        inputSchema: Shape
        annotations?: ToolAnnotations
        public?: boolean
      },
      handle: (
        args: z.output<z.ZodObject<Shape>>,
        context: RequestContext,
      ) => Promise<CallToolResult> | CallToolResult,
    ) {
      const schema = z.strictObject(definition.inputSchema)
      tools.push({
        name,
        description: definition.description,
        schema,
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
        ...(definition.public ? { public: true } : {}),
        // The dispatcher validates this exact schema before invoking the typed callback.
        handle: (args, context) => handle(args as z.output<z.ZodObject<Shape>>, context),
      })
    },
  }
}

export type McpToolRegistry = ReturnType<typeof createMcpToolRegistry>

interface McpServerBaseOptions {
  /** Restrict even request-resolved identities to stdio/in-memory (local account selectors). */
  localOnly?: boolean
  /** Additional tools share the same authentication boundary as generated CRUD. */
  tools?: readonly McpExtensionTool[]
  /** Select generated tools; omitted means every model is exposed with its access rules. */
  includeTool?: (tool: Readonly<CloudConfigToolDef>) => boolean
  /** Full custom data stack (any engine, any ORM). Takes precedence over `db`. */
  data?: DataProvider
  /** A connection-level SQLite driver from `cloudconfig/drivers/*`. */
  db?: DbProvider
  /** Platform bindings passed through to the data driver (e.g. Cloudflare `env`). */
  env?: Record<string, unknown>
  /** Overrides the advertised server name / version. */
  serverInfo?: { name: string; version: string }
}

type McpAuthentication<TUser> =
  | {
      /** Resolve each caller from its HTTP headers or validated MCP bearer token. */
      getUser: GetUser<TUser>
      principal?: never
      allowAnonymous?: never
    }
  | {
      /** A fixed process-local identity for a stdio MCP server. */
      principal: NonNullable<TUser>
      getUser?: never
      allowAnonymous?: never
    }
  | {
      /** Explicitly permit unauthenticated access on a process-local dev transport. */
      allowAnonymous: true
      getUser?: never
      principal?: never
    }

export type McpServerOptions<TUser = unknown> = McpServerBaseOptions & McpAuthentication<TUser>

export interface CloudConfigMcpServer extends Server {
  /** Use the host's own transport instance, including when callers load through jiti/CJS. */
  connectStdio(): Promise<void>
}

type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

/** Fallback origin for the synthetic `Request` when the transport carries no URL. */
const MCP_REQUEST_URL = 'http://cloudconfig.mcp/'

/**
 * Build an MCP `Server` exposing CRUD tools for every model in `config`. The
 * caller drives the transport: `server.connect(new StdioServerTransport())` for
 * a local agent, or any other `Transport` the SDK supports.
 *
 * Identity is fail-closed: declare exactly one of `getUser`, `principal`, or
 * `allowAnonymous: true`. The latter two are process-local only — `connect`
 * refuses any transport that is not stdio or in-memory.
 */
export function createMcpServer<C extends AnyConfig, TUser = unknown>(
  config: C,
  opts: McpServerOptions<TUser>,
): CloudConfigMcpServer {
  const authMode = validateAuthentication(opts)
  const ops = createOperations(config, {
    ...(opts.data ? { data: opts.data } : {}),
    ...(opts.db ? { db: opts.db } : {}),
  })

  const tools = buildToolDefs(ops.base).filter((tool) => opts.includeTool?.(tool) ?? true)
  const extensions = opts.tools ?? []
  const extensionByName = new Map<string, McpExtensionTool>()
  const byName = new Map(tools.map((t) => [t.name, t]))

  for (const tool of extensions) {
    if (byName.has(tool.name) || extensionByName.has(tool.name)) {
      throw new Error(
        `Duplicate MCP tool: ${tool.name}. Select generated tools explicitly before replacing one.`,
      )
    }
    extensionByName.set(tool.name, tool)
  }

  const server = new Server(opts.serverInfo ?? { name: 'cloudconfig', version: '0.0.0' }, {
    capabilities: { tools: {} },
  })
  enforceTransportPolicy(server, authMode, opts.localOnly ?? false)

  server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    const hasPublicTools = extensions.some((tool) => tool.public)
    const ctx = await authenticatedContext(opts, authMode, extra, hasPublicTools)
    const hasIdentity = authMode !== 'request' || ctx.user != null
    return {
      tools: [
        ...(hasIdentity
          ? tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            }))
          : []),
        ...extensions
          .filter((tool) => hasIdentity || tool.public)
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: toInputSchema(tool.schema),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
      ],
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const extension = extensionByName.get(req.params.name)
    const ctx = await authenticatedContext(opts, authMode, extra, extension?.public ?? false)
    const args = req.params.arguments ?? {}
    if (extension) {
      const parsed = await extension.schema.safeParseAsync(args)
      if (!parsed.success) return errorResult(`Validation failed: ${parsed.error.message}`)
      try {
        return await extension.handle(parsed.data, ctx)
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : 'Tool execution failed.')
      }
    }
    const tool = byName.get(req.params.name)
    if (!tool) return errorResult(`Unknown tool: ${req.params.name}`)
    return dispatch(ops, ctx, tool, args)
  })

  return Object.assign(server, {
    connectStdio: () => server.connect(new StdioServerTransport()),
  })
}

type AuthMode = 'request' | 'principal' | 'anonymous'

function validateAuthentication<TUser>(opts: McpServerOptions<TUser>): AuthMode {
  const modes = [
    typeof opts.getUser === 'function',
    'principal' in opts,
    opts.allowAnonymous === true,
  ].filter(Boolean).length
  if (modes !== 1) {
    throw new Error(
      'MCP authentication requires exactly one of getUser, principal, or allowAnonymous: true.',
    )
  }
  if (typeof opts.getUser === 'function') return 'request'
  if ('principal' in opts) {
    if (opts.principal == null) throw new Error('MCP principal must not be null or undefined.')
    return 'principal'
  }
  return 'anonymous'
}

function enforceTransportPolicy(server: Server, authMode: AuthMode, localOnly: boolean): void {
  const connect = server.connect.bind(server)
  server.connect = async (transport: Transport): Promise<void> => {
    if ((localOnly || authMode !== 'request') && !isProcessLocalTransport(transport)) {
      throw new Error(
        'Network MCP transports require getUser and localOnly: false; local identities are process-local only.',
      )
    }
    await connect(transport)
  }
}

function isProcessLocalTransport(transport: Transport): boolean {
  return transport instanceof StdioServerTransport || transport instanceof InMemoryTransport
}

async function authenticatedContext<TUser>(
  opts: McpServerOptions<TUser>,
  authMode: AuthMode,
  extra: McpRequestExtra,
  allowUnresolved = false,
): Promise<RequestContext> {
  const request = requestFromMcp(extra)
  let user: TUser | null
  if (authMode === 'request') {
    user = await opts.getUser!(request, { env: opts.env })
    if (user == null && !allowUnresolved) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Unauthorized: caller identity could not be resolved.',
      )
    }
  } else if (authMode === 'principal') {
    user = opts.principal!
  } else {
    user = null
  }
  return {
    request,
    user,
    ...(opts.env ? { env: opts.env } : {}),
  }
}

function requestFromMcp(extra: McpRequestExtra): Request {
  const headers = requestHeaders(extra.requestInfo)
  applyAuthenticatedMetadata(headers, extra.authInfo, extra.sessionId)
  return new Request(extra.requestInfo?.url ?? MCP_REQUEST_URL, { headers })
}

function requestHeaders(info: RequestInfo | undefined): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(info?.headers ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}

function applyAuthenticatedMetadata(
  headers: Headers,
  authInfo: AuthInfo | undefined,
  sessionId: string | undefined,
): void {
  headers.delete('x-cloudconfig-mcp-client-id')
  headers.delete('x-cloudconfig-mcp-scopes')
  headers.delete('x-cloudconfig-mcp-session-id')
  if (authInfo) {
    headers.set('authorization', `Bearer ${authInfo.token}`)
    headers.set('x-cloudconfig-mcp-client-id', authInfo.clientId)
    headers.set('x-cloudconfig-mcp-scopes', authInfo.scopes.join(' '))
  }
  if (sessionId) headers.set('x-cloudconfig-mcp-session-id', sessionId)
}

async function dispatch(
  ops: Operations,
  ctx: RequestContext,
  tool: CloudConfigToolDef,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = await runTool(ops, ctx, tool, args)
  if (result.ok && tool.action === 'describe' && isRecord(result.value)) {
    return textResult(JSON.stringify(result.value, null, 2), result.value)
  }
  return toResult(result)
}

// Result mapping

function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Map a transport-neutral `OpResult` to an MCP tool result. */
function toResult(result: OpResult<unknown>): CallToolResult {
  if (result.ok) {
    if (result.value === null) return textResult('Deleted.')
    const structured = isRecord(result.value) ? result.value : { result: result.value }
    return textResult(JSON.stringify(result.value, null, 2), structured)
  }
  return errorResult(errorMessage(result.code, result.issues, result.reason))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(
  code: OpErrorCode,
  issues?: ValidationIssue[],
  reason?: OpErrorReason,
): string {
  switch (code) {
    case 'unknown_model':
      return 'Unknown resource.'
    case 'invalid_id':
      return 'Invalid id: expected a number.'
    case 'not_found':
      return 'Not found.'
    case 'forbidden':
      return reason === 'no_rule'
        ? 'Forbidden: no access rule grants this action, and access defaults to deny — add an `access` rule for the model.'
        : 'Forbidden: an access rule denies this action.'
    case 'validation':
      return `Validation failed:\n${(issues ?? [])
        .map((i) => `  - ${i.path || '(root)'}: ${i.message}`)
        .join('\n')}`
    case 'conflict':
      return 'This record changed while saving. Reload it and try again.'
    case 'storage_failed':
    case 'payload_too_large':
    case 'unsupported_media_type':
      return issues?.[0]?.message ?? 'File storage failed.'
    case 'write_failed':
      return 'Failed to create record.'
  }
}
