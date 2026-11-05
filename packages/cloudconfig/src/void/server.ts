import type { AnyConfig } from '../index.js'
import { d1 } from '../drivers/d1.js'
import {
  createBackend,
  createServerClient,
  type BackendOptions,
  type OperationsOptions,
  type RequestContext,
  type ServerClient,
} from '../server/index.js'

/**
 * Mount the schema-derived REST API, auth, Connect and OpenAPI on Void's D1 binding.
 * Forward the Void handler's original Request and bindings to the returned app's fetch method.
 */
export function createVoidBackend<C extends AnyConfig>(
  config: C,
  options: Omit<BackendOptions, 'db' | 'data'> = {},
): ReturnType<typeof createBackend> {
  return createBackend(config, { ...options, db: d1(config.db?.binding) })
}

/** Typed server operations for a Void handler or job; access rules and hooks still apply. */
export function createVoidServerClient<C extends AnyConfig>(
  config: C,
  context: RequestContext,
  options: Omit<OperationsOptions, 'db' | 'data'> = {},
): ServerClient<C> {
  return createServerClient(config, context, { ...options, db: d1(config.db?.binding) })
}
