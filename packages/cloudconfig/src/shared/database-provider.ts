import type { AnyConfig, DatabaseProvider } from '../dsl/model-config.js'
import { resolveDeploymentTarget } from './deployment-target.js'

/** Explicit providers survive host changes; defaults are only for unconfigured projects. */
export function resolveDatabaseProvider(config: AnyConfig): DatabaseProvider {
  const remote = config.db?.remote
  if (remote === undefined) {
    return resolveDeploymentTarget(config.deploy?.target) === 'vercel' ? 'turso' : 'd1'
  }
  const provider = remote?.provider
  if (provider === 'd1' || provider === 'turso' || provider === 'libsql') return provider
  throw new Error(
    `Unsupported db.remote.provider "${String(provider)}". Expected d1, turso or libsql. PostgreSQL and MySQL engines are not supported yet.`,
  )
}
