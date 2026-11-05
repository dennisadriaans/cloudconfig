/**
 * Public entrypoint: `cloudconfig/server`.
 *
 * This is the only public surface allowed to expose drizzle-shaped types (the
 * compiled `SQLiteTable`), which is intentional — it is the DashboardStack
 * replacement bridge. App and client code that must stay drizzle-free import
 * from `cloudconfig` / `cloudconfig/client` instead.
 */
export {
  compileConfig,
  compileTables,
  publicModels,
  type CompiledBase,
  type CompiledModel,
  type CompiledField,
  type CompiledRelationship,
  type FieldMeta,
} from './compile/index.js'
export { toFieldOverrides, type FieldOverride } from './bridge.js'
export { createBackend, type BackendOptions } from './backend.js'
export { createServerClient, type ServerClient } from './client.js'
export { buildOpenApiDocument, type OpenApiDocument, type OpenApiOptions } from './openapi.js'

// Sign-in. `createBackend` wires this automatically when the config has an
// `auth` block; the pieces are exported for a custom transport.
export { createAuthRuntime, type AuthRuntime } from './auth/mount.js'
export { getAuthInstance } from './auth/instance.js'
export { isDevelopment, readEnv } from './auth/env.js'
export type { AuthInstance, AuthSession, AuthUser } from './auth/types.js'

// The ports — the swappable seams.
export { RELATION_PROJECTION_KEYS } from './ports.js'
export type {
  AdapterAggregateQuery,
  AggregateBucket,
  AggregateInterval,
  AggregateOp,
  AggregateQuery,
  AggregateResult,
  ConnectContext,
  DataAdapter,
  DataProvider,
  GetUser,
  GetUserContext,
  ListQuery,
  AdapterListQuery,
  PagedResult,
} from './ports.js'

// The transport-neutral core, for wiring a non-REST transport (e.g. gRPC).
export {
  createOperations,
  type Operations,
  type OperationsOptions,
  type OpResult,
  type OpErrorCode,
  type RequestContext,
  type ValidationIssue,
} from './operations.js'

// Render the whole schema as DDL, for a database no migration can reach
// (a throwaway or in-memory SQLite). The normal path is `cloudconfig db migrate`.
export { createIndexSql, createTableSql, schemaStatements, type TableDdl } from './schema-sql.js'

// The tool vocabulary shared by the MCP transport and in-agent AI SDK tools.
export {
  buildToolDefs,
  runTool,
  listQueryFrom,
  toInputSchema,
  type JsonSchema,
  type CloudConfigToolDef,
  type ToolAction,
} from './tool-defs.js'

// The built-in data adapter (drizzle-on-SQLite) and the connection-level seam.
export { drizzleSqliteAdapter, drizzleSqliteProvider } from './adapters/drizzle-sqlite.js'
export type { Db, DbProvider } from './driver.js'

export type { ObjectStore, ObjectStoreProvider, ObjectStoreContext } from './object-store.js'
