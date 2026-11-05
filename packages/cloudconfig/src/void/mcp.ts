import type { AnyConfig } from '../index.js'
import { d1 } from '../drivers/d1.js'
import { createMcpServer, type McpServerOptions } from '../mcp.js'

/**
 * Generate MCP tools against Void's D1 binding, preserving the required identity mode.
 * Supply env with the handler's bindings. Network transports require per-request identity;
 * fixed and anonymous principals remain restricted to local transports.
 */
export function createVoidMcpServer<C extends AnyConfig, TUser = unknown>(
  config: C,
  options: McpServerOptions<TUser> & { db?: never; data?: never },
) {
  return createMcpServer(config, { ...options, db: d1(config.db?.binding) })
}
