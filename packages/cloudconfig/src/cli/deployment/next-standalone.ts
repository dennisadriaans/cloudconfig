import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Configure Next's supported portable server output without replacing a custom config. */
export function ensureNextStandalone(projectDir: string): void {
  const names = [
    'next.config.ts',
    'next.config.mts',
    'next.config.js',
    'next.config.mjs',
    'next.config.cjs',
  ]
  const path = names.map((name) => join(projectDir, name)).find(existsSync)
  if (!path) {
    writeFileSync(join(projectDir, 'next.config.mjs'), "export default { output: 'standalone' }\n")
    return
  }
  const original = readFileSync(path, 'utf8')
  if (/\boutput\s*:\s*['"]standalone['"]/.test(original)) return
  if (/\boutput\s*:/.test(original)) {
    throw new Error(
      `Set output: 'standalone' in ${relative(projectDir, path)} to deploy Next.js to Azure. The existing output setting was preserved.`,
    )
  }
  const patterns = [
    /(const\s+nextConfig(?:\s*:\s*[^=]+)?\s*=\s*\{)/,
    /(export\s+default\s*\{)/,
    /(module\.exports\s*=\s*\{)/,
  ]
  const pattern = patterns.find((candidate) => candidate.test(original))
  if (!pattern) {
    throw new Error(
      `Add output: 'standalone' to your custom ${relative(projectDir, path)} before deploying to Azure. No config was rewritten.`,
    )
  }
  writeFileSync(path, original.replace(pattern, "$1\n  output: 'standalone',"))
  console.log(`Configured ${relative(projectDir, path)} for Next.js standalone output.`)
}
