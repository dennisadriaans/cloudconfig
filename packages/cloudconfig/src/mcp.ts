/**
 * Public entrypoint: `cloudconfig/mcp`.
 *
 * The MCP transport for a compiled config. Kept on its own subpath (rather than
 * folded into `cloudconfig/server`) so a framework mount that only needs the REST
 * backend never bundles the MCP SDK. Import this only where you actually run an
 * MCP server; drive the transport yourself:
 *
 *   import { createMcpServer } from '@cloudconfig/core/mcp'
 *   import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
 *   const server = createMcpServer(config, { db, principal: serviceUser })
 *   await server.connect(new StdioServerTransport())
 *
 * Identity must be declared explicitly — exactly one of `getUser`, `principal`,
 * or `allowAnonymous: true`. `cloudconfig mcp` runs the local sqlite db with
 * `allowAnonymous: true`, which stdio permits because the process boundary is
 * the security boundary. Network transports must use `getUser`: `connect`
 * rejects a fixed or anonymous principal on anything but stdio / in-memory.
 */
export {
  createMcpServer,
  createMcpToolRegistry,
  type McpServerOptions,
  type CloudConfigMcpServer,
  type McpExtensionTool,
  type McpToolRegistry,
} from './server/mcp.js'
export {
  describeSchema,
  type SchemaDesc,
  type SchemaModelDesc,
  type SchemaFieldDesc,
} from './mcp/schema.js'
