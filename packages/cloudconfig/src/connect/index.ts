/**
 * Public entrypoint: `@cloudconfig/core/connect`.
 *
 * Server-only. Use it from server routes, jobs and agent tools to act through
 * a user's or an organization's connections. Never import it into a browser
 * bundle — use `createConnectClient` from `@cloudconfig/core/client` there.
 */
export {
  actorFromUser,
  ConnectError,
  createConnect,
  onConnectWebhook,
  resolveActor,
  type Connect,
  type ConnectAccess,
  type ConnectActor,
  type ConnectOptions,
  type ConnectWebhookHandler,
  type ConnectionSummary,
  type ProviderSummary,
  type WebhookDelivery,
} from './runtime.js'
export { ProviderError, ReauthorizeError, type FetchLike, type TokenSet } from './http.js'
export type { McpCallResult, McpTool } from './mcp.js'
export type { ConnectTarget, ConnectedAccount } from './providers/types.js'
export type { ConnectionKind, ConnectionStatus } from './store.js'
export {
  signConnectPayload,
  verifyConnectSignature,
  verifyHubSignature,
  verifySlackSignature,
  verifyStripeSignature,
} from './signatures.js'
