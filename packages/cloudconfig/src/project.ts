/**
 * Loads a `cloud.config.ts` from disk via jiti (handles TS + ESM anywhere).
 * The config must export a named `config` (or a default export) built with
 * `defineBackend`. Kept separate from the app import path, which loads the same
 * file directly through the framework's own bundler.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import type { AnyConfig } from './index.js'
import { compileConfig } from './server/compile/index.js'
import { ConfigError } from './shared/errors.js'
import { CONFIG_FILENAMES, resolveConfigExport } from './shared/config-module.js'
import { validateDataServices } from './shared/data-env.js'

export function findConfigPath(dir: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return undefined
}

export async function loadProjectConfig(
  dir: string,
  opts: { allowExternalSchema?: boolean } = {},
): Promise<{ path: string; config: AnyConfig }> {
  const path = findConfigPath(dir)
  if (!path) {
    throw new Error(
      `No ${CONFIG_FILENAMES.join(' or ')} found in ${resolve(dir)}. Run "cloudconfig init" first.`,
    )
  }
  const jiti = createJiti(import.meta.url)
  const mod: Record<string, unknown> = await jiti.import(path)
  const candidate = resolveConfigExport(mod, path)
  validateDataServices(candidate)
  try {
    // Deployment can use an existing app's Drizzle migrations without owning
    // its runtime models. Other commands still require a compilable backend.
    const externalSchema =
      opts.allowExternalSchema &&
      candidate.models !== null &&
      typeof candidate.models === 'object' &&
      !Array.isArray(candidate.models) &&
      Object.keys(candidate.models).length === 0 &&
      !candidate.auth
    if (!externalSchema) compileConfig(candidate)
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`${path}: ${error.message}`)
    }
    throw error
  }
  return { path, config: candidate }
}
