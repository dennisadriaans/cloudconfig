/**
 * Rendering for a {@link MigrationPlan}. Pure string building, so the caller
 * decides whether the text is logged, thrown, or serialized.
 */
import pc from 'picocolors'
import {
  hasBlockingDrift,
  planBlocks,
  type DriftIssue,
  type MigrationPlan,
  type TamperIssue,
} from './preflight.js'

function renderDrift(issue: DriftIssue): string {
  const col = `${issue.table}.${issue.column}`.padEnd(28)
  switch (issue.kind) {
    case 'type-mismatch':
      return `  ${pc.yellow(col)} expected ${pc.cyan(issue.expected ?? '?')}, remote has ${pc.red(issue.actual ?? '?')}`
    case 'missing-column':
      return `  ${pc.yellow(col)} ${pc.red('MISSING')} on remote (schema expects it)`
    case 'unexpected-column':
      return `  ${pc.dim(col)} present on remote but not in schema ${pc.dim('(informational)')}`
  }
}

function renderTamper(issue: TamperIssue): string {
  return `  ${pc.yellow(issue.name)} — ${issue.detail}`
}

/** One-line summary for a log line. */
export function summarizePlan(plan: MigrationPlan): string {
  const parts = [
    plan.pending.length === 0
      ? 'no pending migrations'
      : `${plan.pending.length} pending migration${plan.pending.length === 1 ? '' : 's'}`,
  ]
  if (plan.drift.length > 0) parts.push(`${plan.drift.length} schema drift`)
  if (plan.tamper.length > 0) parts.push(`${plan.tamper.length} tamper`)
  return parts.join(', ')
}

/**
 * Full report for a plan that is not clean. Severity drives tone: real drift
 * reads as an error with the `--force` escape hatch, a cosmetic-only plan reads
 * as a warning with no scary bypass line.
 */
export function renderReport(plan: MigrationPlan): string {
  const lines: string[] = []
  const blocks = planBlocks(plan)
  const blockingDrift = plan.drift.filter((change) => change.kind !== 'unexpected-column')
  const infoDrift = plan.drift.filter((change) => change.kind === 'unexpected-column')

  if (plan.tamper.length > 0) {
    lines.push(
      pc.bold(`${blocks ? pc.red('✘') : pc.yellow('⚠')}  Applied migrations are missing locally`),
    )
    lines.push('')
    for (const t of plan.tamper) lines.push(renderTamper(t))
    lines.push('')
    lines.push(
      pc.dim(
        blocks
          ? '  Restore the original migration filename(s), or write a new forward\n  migration instead of editing applied ones.'
          : '  The live schema still matches your migrations, so this is safe to\n  ignore. To silence it, restore the original filename(s).',
      ),
    )
    lines.push('')
  }

  if (blockingDrift.length > 0) {
    lines.push(pc.bold(pc.red('✘  Remote D1 schema does not match your migrations')))
    lines.push('')
    for (const change of blockingDrift) lines.push(renderDrift(change))
    if (infoDrift.length > 0) {
      lines.push('')
      for (const change of infoDrift) lines.push(renderDrift(change))
    }
    lines.push('')
    lines.push(
      pc.dim('  Restore the remote schema to the applied migration baseline, then redeploy.'),
    )
    lines.push('')
  } else if (infoDrift.length > 0) {
    lines.push(pc.bold(pc.yellow('⚠  Remote D1 has columns not in your schema')))
    lines.push('')
    for (const change of infoDrift) lines.push(renderDrift(change))
    lines.push('')
  }

  if (plan.driftBaseline && plan.drift.length > 0) {
    lines.push(
      pc.dim(`  Compared against ${plan.driftBaseline} (the last migration the remote applied).`),
    )
    lines.push('')
  }

  if (blocks) {
    lines.push(
      pc.dim('  Bypass (unsafe, may break production): ') + pc.cyan('cloudconfig deploy --force'),
    )
  }

  return lines.join('\n').replace(/\n+$/, '')
}

/**
 * Post-migration verification report: the live schema after the migrations ran,
 * against the schema the app about to be deployed expects.
 */
export function renderTargetDrift(drift: readonly DriftIssue[]): string {
  const blocking = drift.filter((change) => change.kind !== 'unexpected-column')
  const info = drift.filter((change) => change.kind === 'unexpected-column')
  const lines: string[] = []

  if (blocking.length > 0) {
    lines.push(pc.bold(pc.red('✘  Remote D1 does not match your schema after migrating')))
    lines.push('')
    for (const change of blocking) lines.push(renderDrift(change))
    lines.push('')
    lines.push(pc.dim('  The migrations applied but did not produce the expected schema.'))
    lines.push(pc.dim('  Deploying the app now would run it against a schema it does not expect.'))
  } else if (info.length > 0) {
    lines.push(pc.bold(pc.yellow('⚠  Remote D1 has columns not in your schema')))
    lines.push('')
    for (const change of info) lines.push(renderDrift(change))
  }
  return lines.join('\n').replace(/\n+$/, '')
}

/** Short pending listing for a dry run. */
export function renderPendingList(plan: MigrationPlan): string {
  if (plan.pending.length === 0) return pc.dim('  No pending migrations.')
  return plan.pending.map((f) => `  ${pc.green('+')} ${f}`).join('\n')
}

export { hasBlockingDrift }
