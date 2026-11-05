/**
 * CLI error formatting — kept separate from the entrypoint so tests can import
 * it without starting `main()`.
 */
import { detectPackageManager, installDevDepCommand } from './package-manager.js'
import { isMissingPackageError, missingBetterSqlite3Message } from '../shared/better-sqlite3.js'
import { isPortInUseError, portInUseMessage } from './dev-port.js'

/** Rewrite cryptic missing-peer / bind errors into actionable hints. */
const NATIVE_BINDING_REPAIRS: Partial<Record<string, string>> = {
  pnpm: 'pnpm approve-builds (select better-sqlite3), then pnpm rebuild better-sqlite3',
  npm: 'npm rebuild better-sqlite3',
}

export function formatCliError(err: unknown, projectDir: string): string {
  if (
    err instanceof Error &&
    err.message.includes('better_sqlite3.node') &&
    err.message.includes('Could not locate the bindings file')
  ) {
    const repair =
      NATIVE_BINDING_REPAIRS[detectPackageManager(projectDir)] ??
      'Reinstall better-sqlite3 with dependency install scripts enabled.'
    return `Cannot load the better-sqlite3 native binding (required for local SQLite).\n\n  Repair: ${repair}\n\nThen re-run this command.`
  }
  if (isMissingPackageError(err, 'better-sqlite3')) {
    return missingBetterSqlite3Message(
      installDevDepCommand(detectPackageManager(projectDir), 'better-sqlite3'),
    )
  }
  if (isPortInUseError(err)) {
    const port =
      typeof err === 'object' && err !== null && 'port' in err
        ? Number((err as NodeJS.ErrnoException & { port?: number }).port)
        : NaN
    return portInUseMessage(Number.isFinite(port) ? port : 3000)
  }
  return err instanceof Error ? err.message : String(err)
}
