import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { GENERATED_VOID_HEADER } from './paths.js'

export const VOID_MIGRATION_MARKER = '.cloudconfig-generated'
const DESTRUCTIVE_PRAGMA = '-- void:allow-destructive'

export function parseVoidMigrationApprovals(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'Void destructive migration approvals must map SQL filenames to SHA-256 hashes.',
    )
  }
  const approvals: Record<string, string> = {}
  for (const [name, hash] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/.test(name) ||
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      throw new Error(
        `Invalid Void migration approval for ${name}; use a SQL filename and its SHA-256 hash.`,
      )
    }
    approvals[name] = hash
  }
  return approvals
}

/** Approve exact source bytes; annotation changes are confined to the generated mirror. */
export async function readApprovedMigrationAnnotations(
  source: string,
  target: string,
  approvals: Readonly<Record<string, string>>,
): Promise<ReadonlyMap<string, string>> {
  if (source === target && Object.keys(approvals).length) {
    throw new Error(
      'Void migration approvals require a separate mirror; authoritative SQL is never annotated.',
    )
  }
  const annotations = new Map<string, string>()
  for (const [name, expectedHash] of Object.entries(approvals)) {
    const bytes = await readFile(resolve(source, name))
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== expectedHash) {
      throw new Error(
        `Migration ${name} changed since its Void approval. Review the SQL before updating its SHA-256 hash.`,
      )
    }
    const sql = bytes.toString('utf8')
    annotations.set(
      name,
      /^-- void:allow-destructive[ \t]*\r?$/m.test(sql) ? sql : `${DESTRUCTIVE_PRAGMA}\n${sql}`,
    )
  }
  return annotations
}

/** Replace only a generated mirror, retaining its previous contents if installation fails. */
export async function mirrorVoidMigrations(
  source: string,
  target: string,
  annotations: ReadonlyMap<string, string>,
): Promise<void> {
  if (source === target) return
  await mkdir(dirname(target), { recursive: true })
  const staging = await mkdtemp(resolve(dirname(target), '.cloudconfig-void-migrations-'))
  const next = resolve(staging, 'next')
  const previous = resolve(staging, 'previous')
  let hasPrevious = false
  let hasInstalled = false
  try {
    await cp(source, next, { recursive: true })
    for (const [name, sql] of annotations) await writeFile(resolve(next, name), sql)
    await writeFile(resolve(next, VOID_MIGRATION_MARKER), GENERATED_VOID_HEADER)
    try {
      await rename(target, previous)
      hasPrevious = true
    } catch (cause) {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause
    }
    try {
      await rename(next, target)
      hasInstalled = true
    } catch (cause) {
      if (hasPrevious) {
        await rename(previous, target)
        hasPrevious = false
      }
      throw cause
    }
  } finally {
    // A failed restore leaves the previous mirror here for recovery.
    if (!hasPrevious || hasInstalled) await rm(staging, { recursive: true, force: true })
  }
}
