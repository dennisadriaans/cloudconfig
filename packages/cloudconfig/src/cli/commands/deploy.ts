import { basename, join, resolve } from 'node:path'
import { loadConfig } from '../config-load.js'
import { listLocalMigrationFiles } from '../cloudflare/migration-preflight.js'
import { resolveProjectConfig } from '../../shared/project-config.js'
import { dbGenerate } from './db.js'
import { detectFramework } from '../detect.js'
import { resolveDeploymentTarget } from '../../shared/deployment-target.js'
import { deployHostedProject } from '../deployment/deploy.js'
import { vercelHosting } from '../deployment/adapters/vercel.js'
import { azureHosting } from '../deployment/adapters/azure.js'
import type { DeployOptions } from '../deployment/ports.js'

export type { DeployOptions } from '../deployment/ports.js'

/** Composition root. The selected adapter owns the provider's tools and artifacts. */
export async function deployCommand(
  projectDir: string,
  options: DeployOptions = {},
): Promise<void> {
  const { config, path } = await loadConfig(projectDir, { allowExternalSchema: true })
  const target = resolveDeploymentTarget(config.deploy?.target)
  if (target === 'cloudflare') {
    const { deployCloudflare } = await import('./deploy-cloudflare.js')
    await deployCloudflare({
      projectDir,
      configPath: path,
      config,
      framework: detectFramework(projectDir),
      target,
      name: config.deploy?.name ?? config.deploy?.worker ?? basename(resolve(projectDir)),
      options,
    })
    return
  }
  if (
    !listLocalMigrationFiles(join(projectDir, resolveProjectConfig(config).migrationsDir)).length &&
    !options.dryRun
  ) {
    if (!Object.keys(config.models).length && !config.auth) {
      throw new Error(
        'Generate SQL migrations and snapshots with the application schema tooling before deploying.',
      )
    }
    await dbGenerate(projectDir)
    if (process.exitCode) return
  }
  const name =
    config.deploy?.name ??
    basename(resolve(projectDir))
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
  if (!/^[a-z][a-z0-9-]{1,58}[a-z0-9]$/.test(name)) {
    throw new Error(
      'deploy.name must be 3–60 lowercase letters, digits or hyphens, start with a letter, and end with a letter or digit.',
    )
  }
  await deployHostedProject(
    {
      projectDir,
      configPath: path,
      config,
      framework: detectFramework(projectDir),
      target,
      name,
      options,
    },
    target === 'vercel' ? vercelHosting : azureHosting,
  )
}
