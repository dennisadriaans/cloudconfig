import {
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { nodeFileTrace } from '@vercel/nft'
import { ZipFile } from 'yazl'

/** Package traced runtime dependencies, preserving pnpm/workspace symlinks inside the artifact. */
export async function packageNodeEntry(
  entry: string,
  directory: string,
  options: { cwd?: string } = {},
): Promise<string> {
  // A workspace dependency can live outside the application directory. NFT silently
  // omits files outside its base, so trace from the filesystem root, then rebase the result.
  const base = parse(entry).root
  const { fileList } = await nodeFileTrace([entry], {
    base,
    processCwd: options.cwd ?? dirname(entry),
    ignore: ['**/.env', '**/.env.*', '**/.cloudconfig/dev.db', '**/.cloudconfig/uploads/**'],
  })
  const paths = [...fileList]
    .map((file) => resolve(base, file))
    .filter((file) => !isEnvironmentFile(file))
  let root = dirname(entry)
  // Targets must exist before linking them, particularly with pnpm's directory symlinks.
  const ordered = paths.sort(
    (left, right) =>
      Number(lstatSync(left).isSymbolicLink()) - Number(lstatSync(right).isSymbolicLink()),
  )
  for (const path of ordered) {
    while (!isWithin(root, path)) root = dirname(root)
  }
  const runtime = join(directory, 'runtime')
  for (const path of paths) {
    const destination = join(runtime, relative(root, path))
    mkdirSync(dirname(destination), { recursive: true })
    if (lstatSync(path).isSymbolicLink()) {
      const link = readlinkSync(path)
      const target = isAbsolute(link) ? link : resolve(dirname(path), link)
      if (!isWithin(root, target)) {
        throw new Error(`Runtime dependency symlink escapes the packaged files: ${path}`)
      }
      const packagedTarget = join(runtime, relative(root, target))
      if (!existsSync(destination)) {
        symlinkSync(relative(dirname(destination), packagedTarget), destination)
      }
    } else if (!lstatSync(path).isDirectory()) {
      cpSync(path, destination)
    }
  }
  return relative(directory, join(runtime, relative(root, entry)))
    .split(sep)
    .join('/')
}

function isEnvironmentFile(path: string): boolean {
  return path.split(sep).some((part) => /^\.env(?:\.|$)/.test(part))
}

function isWithin(directory: string, path: string): boolean {
  const child = relative(directory, path)
  return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}

/** Zip only the prepared runtime, never source .env files or the developer's local database. */
export async function zipDirectory(directory: string, destination: string): Promise<void> {
  // Kudu's ZIP extraction does not reliably preserve Unix symlinks. The Node bootstrap
  // restores this manifest before loading the runtime, including pnpm's directory links.
  const links: Record<string, string> = {}
  const files: { path: string; name: string }[] = []
  function collectFiles(folder: string): void {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      const name = relative(directory, path).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path)
        // Optional platform dependencies may be dangling links in Next's own output.
        // They must remain inside the runtime even when their optional target is absent.
        if (!isWithin(directory, resolve(dirname(path), target))) {
          throw new Error(
            `Runtime dependency ${name} points outside the deployment artifact. For a Next.js monorepo, configure outputFileTracingRoot to include the workspace dependencies and rebuild.`,
          )
        }
        links[name] = target
      } else if (entry.isDirectory()) collectFiles(path)
      else files.push({ path, name })
    }
  }
  collectFiles(directory)
  const archive = new ZipFile()
  archive.on('error', (cause: Error) => archive.outputStream.emit('error', cause))
  for (const { path, name } of files) archive.addFile(path, name)
  archive.addBuffer(Buffer.from(JSON.stringify(links)), 'cloudconfig-symlinks.json')
  archive.end()
  await pipeline(archive.outputStream, createWriteStream(destination))
}
