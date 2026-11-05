/**
 * Public entrypoint: `cloudconfig`.
 *
 * HARD RULE — this module and everything it imports must have ZERO node_modules
 * imports (no drizzle, no zod, no hono) and must never reach into `server/`,
 * `cli/`, or `deploy/`. A user's `cloud.config.ts` imports only from here, so
 * importing the config into a browser bundle must pull in nothing but pure data
 * builders and phantom types. This is the leak-containment firewall for the
 * "drizzle hidden under the DSL" design.
 */

export type { FieldKind, OnDelete, FieldSpec } from './dsl/field-spec.js'
export {
  FIELD_SPEC_KEY,
  getFieldSpec,
  t,
  type Field,
  type RelationField,
  type AnyField,
} from './dsl/fields.js'
export type {
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterOperator,
  FilterValue,
  WhereBuilder,
  AccessAction,
  AccessCtx,
  AccessResult,
  CloudConfigUser,
  CloudConfigOrganization,
  AccessRule,
  AccessRules,
  HookCtx,
  ChangeEvent,
  ModelHooks,
  ModelOptions,
  ModelValidator,
} from './dsl/filters.js'
export type { ValidationIssue } from './shared/errors.js'
export type { ModelStorage, StorageFields } from './dsl/storage.js'
export {
  model,
  defineBackend,
  type Model,
  type AnyModel,
  type DatabaseProvider,
  type RemoteDatabaseConfig,
  type CloudConfigConfig,
  type AnyConfig,
  type DeployConfig,
  type DeploymentTarget,
  type AgentDeployment,
  type WorkflowDeployment,
  type WorkerExport,
} from './dsl/model-config.js'
export { workerExports, agentDeployment, automationDeployment } from './shared/worker-exports.js'
export {
  automationSchedules,
  AUTOMATION_ADMIN_KEY,
  AUTOMATION_CONFIG_PATH,
} from './shared/automation-config.js'
export { resolveDeploymentTarget, deploymentPreset } from './shared/deployment-target.js'
export { resolveDatabaseProvider } from './shared/database-provider.js'
export { hasOrgRole, orgRows, ownOrgRows } from './dsl/organization.js'
export {
  defineConnect,
  CONNECT_PROVIDER_IDS,
  type ConnectConfig,
  type ConnectCustomProviderConfig,
  type ConnectMcpConfig,
  type ConnectProviderConfig,
  type ConnectProviderId,
  type ConnectionScope,
} from './dsl/connect-config.js'
export {
  resolveConnect,
  connectEnvNames,
  connectEnvPrefix,
  connectCallbackUrl,
  connectWebhookUrl,
  DEFAULT_CONNECT_KEY_ENV,
  MCP_PROVIDER_ID,
  type ResolvedConnect,
  type ResolvedConnectProvider,
} from './shared/connect-resolve.js'
export {
  CONNECT_PROVIDERS,
  connectProviderInfo,
  type ConnectProviderInfo,
} from './shared/connect-providers.js'
export {
  defineAuth,
  AUTH_PROVIDER_IDS,
  type AuthAdminConfig,
  type AuthConfig,
  type AuthOrganizationsConfig,
  type AuthScimConfig,
  type AuthTwoFactorConfig,
  type AuthProviderConfig,
  type AuthProviderId,
  type DevIdpUser,
} from './dsl/auth-config.js'
export {
  resolveAuth,
  providerEnvNames,
  providerCallbackUrl,
  genericCallbackUrl,
  DEFAULT_AUTH_SECRET_ENV,
  DEFAULT_AUTH_URL_ENV,
  DEV_IDP_PROVIDER_ID,
  DEV_IDP_SEGMENT,
  type ResolvedAuth,
  type ResolvedAuthProvider,
} from './shared/auth-resolve.js'
export { providerConsole, providerLabel, type ProviderConsole } from './shared/auth-providers.js'
export {
  resolveProjectConfig,
  normalizeBasePath,
  DEFAULT_BASE_PATH,
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_D1_BINDING,
  type ResolvedProjectConfig,
} from './shared/project-config.js'
export { LOCAL_DB_PATH } from './shared/local-db.js'
export { CONFIG_FILENAMES, resolveConfigExport } from './shared/config-module.js'
export type {
  FlatRow,
  InferSelect,
  InferCreate,
  InferUpdate,
  InferServerSelect,
  InferServerCreate,
} from './dsl/infer.js'
