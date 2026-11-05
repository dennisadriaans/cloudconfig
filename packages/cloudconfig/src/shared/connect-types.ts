/**
 * The shapes Connect puts on the wire. Pure types, shared by the server
 * runtime and the browser client so neither has to import the other.
 */
import type { ConnectionScope } from '../dsl/connect-config.js'

export type ConnectionKind = 'oauth' | 'mcp' | 'api_key'
export type ConnectionStatus = 'pending' | 'active' | 'error' | 'revoked'

/** A place a workspace connection can be pointed at (installation, site, …). */
export interface ConnectTarget {
  id: string
  name: string
  hint?: string
}

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface ConnectionSummary {
  id: number
  uid: string
  provider: string
  kind: ConnectionKind
  scope: ConnectionScope
  organizationId: number | null
  userId: number | null
  status: ConnectionStatus
  statusMessage: string
  label: string
  account: { id: string; name: string; url: string }
  scopes: string[]
  expiresAt: number | null
  /** Pending workspace connections: the choices the user still has to make. */
  targets?: ConnectTarget[]
  /** MCP connections: the server URL. */
  server?: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  /** The caller connected it. */
  mine: boolean
  /** The caller may rename, re-authorize or remove it. */
  canManage: boolean
}

export interface ProviderSummary {
  id: string
  label: string
  kind: 'oauth' | 'mcp'
  configured: boolean
  /** Env vars still missing, by name. Never their values. */
  missing: string[]
  allow: readonly ConnectionScope[]
  scopes: readonly string[]
  startFields: readonly { key: string; label: string; placeholder?: string }[]
  webhooks: boolean
}
