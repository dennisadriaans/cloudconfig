import { loadProjectConfig } from '../../project.js'
import { prepareVoidProject } from '../../void/project.js'

export interface VoidPrepareOptions {
  framework?: boolean
  externalEnv?: boolean
}

/** Generate the Void extension without starting a server, applying SQL or provisioning resources. */
export async function voidPrepareCommand(projectDir: string, options: VoidPrepareOptions = {}) {
  const { path: configPath, config } = await loadProjectConfig(projectDir)
  const prepared = await prepareVoidProject({
    projectDir,
    configPath,
    config,
    ...(options.framework ? { mount: 'framework' as const } : {}),
    ...(options.externalEnv ? { environment: 'external' as const } : {}),
  })
  console.log(`Prepared ${prepared.tableNames.length} CloudConfig tables for Void.`)
  console.log(`Schema: ${prepared.schemaPath}`)
  console.log(`Migrations: ${prepared.migrationsPath}`)
  if ('apiPath' in prepared) console.log(`API mount: ${prepared.apiPath}`)
  if (prepared.workerModulePath) {
    console.log(`Worker adapters: ${prepared.workerModulePath}`)
    console.log('Use the cloudconfigVoid() Vite helper to attach native Worker exports.')
  }
  if (options.externalEnv) {
    console.log(`Compose ${prepared.envPath} into your existing env.ts before deployment.`)
  }
  return prepared
}
