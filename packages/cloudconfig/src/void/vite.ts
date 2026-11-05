import { resolve } from 'node:path'
import { loadProjectConfig } from '../project.js'
import { prepareVoidProject, type VoidProjectOptions } from './project.js'

export interface VoidPluginOptions {
  projectDir?: string
  mount?: VoidProjectOptions['mount']
  environment?: VoidProjectOptions['environment']
  approvedDestructiveMigrations?: VoidProjectOptions['approvedDestructiveMigrations']
}

/** The Vite hooks used here are structural so consumers keep their own Vite peer context. */
export interface CloudConfigVoidPlugin {
  name: string
  enforce: 'pre'
  config(
    config: unknown,
    environment: { command: 'build' | 'serve'; isPreview?: boolean },
  ): { define: Record<string, string> }
  configResolved(config: { root: string }): void
  transform(code: string, id: string): { code: string; map: null } | undefined
}

/**
 * Prepare the schema-derived backend before constructing voidPlugin().
 * Use plugins: [await cloudconfigVoid(), voidPlugin()]. Does not open a database,
 * migrate, provision, start a server or change the application's routing framework.
 */
export async function cloudconfigVoid(
  options: VoidPluginOptions = {},
): Promise<CloudConfigVoidPlugin> {
  const projectDir = resolve(options.projectDir ?? process.cwd())
  const { path: configPath, config } = await loadProjectConfig(projectDir)
  const { workerModulePath } = await prepareVoidProject({
    projectDir,
    configPath,
    config,
    ...(options.mount ? { mount: options.mount } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.approvedDestructiveMigrations
      ? { approvedDestructiveMigrations: options.approvedDestructiveMigrations }
      : {}),
  })
  // Void 1.1.11 regenerates this native entry during startup and buildStart.
  // Transforming its source keeps the extra exports through both rewrites.
  const workerEntry = resolve(projectDir, '.void/entry.ts').replaceAll('\\', '/')
  return {
    name: 'cloudconfig:void',
    enforce: 'pre',
    config(_config, environment) {
      return {
        define: {
          'import.meta.env.CLOUDCONFIG_VOID_DEV': JSON.stringify(
            environment.command === 'serve' && environment.isPreview !== true,
          ),
        },
      }
    },
    configResolved(viteConfig) {
      if (resolve(viteConfig.root) !== projectDir) {
        throw new Error('Set cloudconfigVoid({ projectDir }) to the same root used by Vite.')
      }
    },
    transform(code, id) {
      if (!workerModulePath || id.replaceAll('\\', '/').split('?')[0] !== workerEntry) {
        return undefined
      }
      return {
        code: `${code}\nexport * from ${JSON.stringify(workerModulePath.replaceAll('\\', '/'))}\n`,
        map: null,
      }
    },
  }
}
