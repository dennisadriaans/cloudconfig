import type { AnyConfig, DeploymentTarget } from '../../dsl/model-config.js'
import type { Framework } from '../detect.js'

export interface DeployOptions {
  force?: boolean
  skipBuild?: boolean
  dryRun?: boolean
}

export interface DeploymentRequest {
  projectDir: string
  configPath: string
  config: AnyConfig
  framework: Framework
  target: DeploymentTarget
  name: string
  options: DeployOptions
}

/** Host lifecycle. Database and byte storage are deliberately separate from this port. */
export interface HostingAdapter {
  readonly target: 'vercel' | 'azure'
  check(request: DeploymentRequest): Promise<void>
  prepare(request: DeploymentRequest): Promise<void>
  build(request: DeploymentRequest, env: Record<string, string>): Promise<void>
  /** Resources that can only be prepared after the build, before data migrations. */
  provision?(request: DeploymentRequest): Promise<void>
  publish(request: DeploymentRequest, env: Record<string, string>): Promise<string>
}

export interface DataDeployment {
  /** Runtime settings, populated with provisioned resource IDs by migrate(). */
  env: Record<string, string>
  migrate(): Promise<void>
}
