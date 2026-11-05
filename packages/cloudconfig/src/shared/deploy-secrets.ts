import type { AnyConfig } from '../dsl/model-config.js'
import { resolveAuth } from './auth-resolve.js'
import { resolveConnect } from './connect-resolve.js'
import { storageEnvNames } from './data-env.js'

export interface DeploySecretNames {
  /** A deploy stops when one has no local value and is not already on the Worker. */
  required: string[]
  /** Uploaded when a local value exists. */
  optional: string[]
}

/**
 * Worker secrets the config implies, beyond those a hosting adapter adds at deploy time.
 *
 * A configured provider whose credentials never reach the Worker is a sign-in that
 * fails in production, so the auth and Connect blocks contribute their secrets
 * without the project listing them twice.
 */
export function deploySecretNames(config: AnyConfig): DeploySecretNames {
  const auth = resolveAuth(config)
  const connect = resolveConnect(config)
  const required = [
    ...new Set([
      ...(config.deploy?.secrets ?? []),
      ...(config.storage ? Object.values(storageEnvNames(config)) : []),
      ...(auth?.requiredSecrets ?? []),
      ...(connect?.requiredSecrets ?? []),
    ]),
  ]
  const optional = [
    ...new Set([...(config.deploy?.optionalSecrets ?? []), ...(connect?.optionalSecrets ?? [])]),
  ].filter((name) => !required.includes(name))
  return { required, optional }
}
