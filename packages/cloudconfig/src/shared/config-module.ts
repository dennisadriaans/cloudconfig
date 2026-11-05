import type { AnyConfig } from '../dsl/model-config.js'

/** New projects use the first name; the second keeps existing projects working. */
export const CONFIG_FILENAMES = ['cloud.config.ts', 'cloudconfig.config.ts'] as const

/**
 * Read a config module without statically referencing an optional export.
 * Bundlers otherwise warn about `default` in named-export projects (and vice versa).
 */
export function resolveConfigExport(module: object, source: string): AnyConfig {
  const config: unknown = Reflect.get(module, 'config') ?? Reflect.get(module, 'default')
  if (typeof config !== 'object' || config === null || !('models' in config)) {
    throw new Error(
      `${source} must export a named "config" or a default built with defineBackend().`,
    )
  }
  return config as AnyConfig
}
