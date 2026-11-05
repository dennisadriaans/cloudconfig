/**
 * Detect the project's package manager so scaffolded commands invoke the
 * locally-installed `cloudconfig` bin the same way the developer would.
 *
 * This matters for `.mcp.json`: `npx cloudconfig mcp` inside a pnpm workspace can miss
 * the workspace-linked bin and fall through to the network, which turns a
 * first-run MCP connection into a silent download (or a failure offline).
 * Emitting `pnpm exec cloudconfig mcp` keeps resolution local.
 *
 * Detection walks up from the project directory because lockfiles live at the
 * workspace root, not in each package.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

export interface RunnerCommand {
  command: string
  args: string[]
}

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

/** `packageManager: "pnpm@10.x"` in package.json is the most explicit signal. */
function fromPackageManagerField(dir: string): PackageManager | undefined {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return undefined
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { packageManager?: unknown }
    if (typeof pkg.packageManager !== 'string') return undefined
    const name = pkg.packageManager.split('@')[0]?.trim()
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name
  } catch {
    // ignore malformed package.json
  }
  return undefined
}

export function detectPackageManager(projectDir: string): PackageManager {
  let dir = projectDir
  // Walk to the filesystem root; workspace lockfiles sit above the project.
  for (;;) {
    const declared = fromPackageManagerField(dir)
    if (declared) return declared
    for (const [file, manager] of LOCKFILES) {
      if (existsSync(join(dir, file))) return manager
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'npm'
}

/** How to run a locally-installed bin (`cloudconfig`) under each package manager. */
export function runnerFor(manager: PackageManager, bin: string, binArgs: string[]): RunnerCommand {
  switch (manager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', bin, ...binArgs] }
    case 'yarn':
      return { command: 'yarn', args: [bin, ...binArgs] }
    case 'bun':
      return { command: 'bunx', args: [bin, ...binArgs] }
    default:
      return { command: 'npx', args: [bin, ...binArgs] }
  }
}

/** Install a package as a devDependency with the project's package manager. */
export function installDevDepCommand(manager: PackageManager, pkg: string): string {
  switch (manager) {
    case 'pnpm':
      return `pnpm add -D ${pkg}`
    case 'yarn':
      return `yarn add -D ${pkg}`
    case 'bun':
      return `bun add -d ${pkg}`
    default:
      return `npm install -D ${pkg}`
  }
}

/** Install a package as a runtime dependency with the project's package manager. */
export function installDepCommand(manager: PackageManager, pkg: string): string {
  switch (manager) {
    case 'pnpm':
      return `pnpm add ${pkg}`
    case 'yarn':
      return `yarn add ${pkg}`
    case 'bun':
      return `bun add ${pkg}`
    default:
      return `npm install ${pkg}`
  }
}

/** Install dependencies already declared in package.json. */
export function installCommand(manager: PackageManager): string {
  switch (manager) {
    case 'pnpm':
      return 'pnpm install'
    case 'yarn':
      return 'yarn'
    case 'bun':
      return 'bun install'
    default:
      return 'npm install'
  }
}

/** Run a package.json script with the project's package manager. */
export function runScriptCommand(manager: PackageManager, script: string): string {
  switch (manager) {
    case 'pnpm':
      return script === 'deploy' ? 'pnpm run deploy' : `pnpm ${script}`
    case 'yarn':
      return `yarn ${script}`
    case 'bun':
      return `bun run ${script}`
    default:
      return `npm run ${script}`
  }
}
