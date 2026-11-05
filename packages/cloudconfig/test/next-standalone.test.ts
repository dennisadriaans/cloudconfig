import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { ensureNextStandalone } from '../src/cli/deployment/next-standalone.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function project(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cloudconfig-next-output-'))
  directories.push(directory)
  return directory
}

it('prepares portable Next output while preserving the existing config and comments', () => {
  const directory = project()
  const path = join(directory, 'next.config.ts')
  writeFileSync(
    path,
    "// Keep our framework settings\nconst nextConfig: NextConfig = { basePath: '/notes' }\nexport default withPlugin(nextConfig)\n",
  )
  ensureNextStandalone(directory)
  const updated = readFileSync(path, 'utf8')
  expect(updated).toContain("output: 'standalone'")
  expect(updated).toContain("basePath: '/notes'")
  expect(updated).toContain('// Keep our framework settings')
  expect(updated).toContain('export default withPlugin(nextConfig)')
  ensureNextStandalone(directory)
  expect(readFileSync(path, 'utf8')).toBe(updated)
})

it('creates ESM config when a project has no Next config', () => {
  const directory = project()
  ensureNextStandalone(directory)
  expect(readFileSync(join(directory, 'next.config.mjs'), 'utf8')).toBe(
    "export default { output: 'standalone' }\n",
  )
})

it.each([
  "export default { output: 'export' }\n",
  'export default async () => loadCustomConfig()\n',
])('preserves conflicting or opaque configs and reports the needed setup', (original) => {
  const directory = project()
  const path = join(directory, 'next.config.mjs')
  writeFileSync(path, original)
  expect(() => ensureNextStandalone(directory)).toThrow('standalone')
  expect(readFileSync(path, 'utf8')).toBe(original)
})
