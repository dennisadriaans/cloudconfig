import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Locate the CLI's own manifest in source and bundled layouts, independently of the caller's cwd. */
export function readCloudconfigPackage(): { directory: string; version: string } {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const path = join(directory, 'package.json')
    if (existsSync(path)) {
      const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (
        manifest &&
        typeof manifest === 'object' &&
        'name' in manifest &&
        manifest.name === '@cloudconfig/core'
      ) {
        if (!('version' in manifest) || typeof manifest.version !== 'string' || !manifest.version) {
          throw new Error('The @cloudconfig/core package has no version. Reinstall the package.')
        }
        return { directory, version: manifest.version }
      }
    }
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error('Cannot locate the @cloudconfig/core package used by this CLI.')
    }
    directory = parent
  }
}
