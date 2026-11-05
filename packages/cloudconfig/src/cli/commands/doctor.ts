/**
 * `cloudconfig doctor` — print a readiness report for the current CloudConfig project.
 */
import pc from 'picocolors'
import { runDoctor, type DoctorCheck, type DoctorStatus } from '../doctor.js'

function mark(status: DoctorStatus): string {
  switch (status) {
    case 'ok':
      return pc.green('ok')
    case 'warn':
      return pc.yellow('warn')
    case 'fail':
      return pc.red('fail')
  }
}

function printCheck(check: DoctorCheck): void {
  const head = `${mark(check.status)}  ${pc.bold(check.label)}`
  const lines = check.detail.split('\n')
  console.log(`${head}  ${lines[0] ?? ''}`)
  for (const line of lines.slice(1)) {
    console.log(`       ${line}`)
  }
}

export async function doctorCommand(projectDir: string): Promise<void> {
  const report = await runDoctor(projectDir)
  console.log(pc.bold('\nCloudConfig doctor\n'))
  for (const check of report.checks) printCheck(check)
  console.log()
  if (report.ok) {
    const warnings = report.checks.filter((c) => c.status === 'warn').length
    if (warnings > 0) {
      console.log(pc.yellow(`Ready with ${warnings} warning(s).`))
    } else {
      console.log(pc.green('All checks passed.'))
    }
  } else {
    const failed = report.checks.filter((c) => c.status === 'fail').length
    console.log(
      pc.red(`${failed} check(s) failed. Fix the items above, then re-run: cloudconfig doctor`),
    )
    process.exitCode = 1
  }
}
