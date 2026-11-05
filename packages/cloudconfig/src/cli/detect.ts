/**
 * Detects the host framework of a project (or standalone) by inspecting its
 * package.json dependencies, with config-file presence as a fallback.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Framework = 'nuxt' | 'next' | 'standalone'

function readDeps(projectDir: string): Record<string, string> {
  const pkgPath = join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) return {}
  try {
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (typeof pkg !== 'object' || pkg === null) return {}
    const deps: Record<string, string> = {}
    for (const key of ['dependencies', 'devDependencies']) {
      if (key in pkg) {
        const section = Reflect.get(pkg, key)
        if (typeof section === 'object' && section !== null) Object.assign(deps, section)
      }
    }
    return deps
  } catch {
    return {}
  }
}

export function detectFramework(projectDir: string): Framework {
  const deps = readDeps(projectDir)
  if (deps['nuxt']) return 'nuxt'
  if (deps['next']) return 'next'

  if (
    existsSync(join(projectDir, 'nuxt.config.ts')) ||
    existsSync(join(projectDir, 'nuxt.config.js'))
  ) {
    return 'nuxt'
  }
  if (
    existsSync(join(projectDir, 'next.config.ts')) ||
    existsSync(join(projectDir, 'next.config.js'))
  ) {
    return 'next'
  }

  return 'standalone'
}
