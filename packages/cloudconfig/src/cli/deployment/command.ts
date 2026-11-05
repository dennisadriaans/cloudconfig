import { run, type RunOptions } from '../exec.js'

/** Capture provider output: it can contain credentials. Surface a safe operation name on failure. */
export async function providerCommand(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<string> {
  let outcome
  try {
    outcome = await run(command, args, options)
  } catch (cause) {
    throw new Error(`Could not start ${command}. Install its CLI and ensure it is on PATH.`, {
      cause,
    })
  }
  if (outcome.code !== 0) {
    let detail = outcome.stderr.trim()
    const credentials = [
      ...Object.entries({ ...process.env, ...options.env })
        .filter(([name]) => /TOKEN|SECRET|PASSWORD|KEY|CONNECTION/i.test(name))
        .map(([, value]) => value),
      options.input,
    ].filter((value): value is string => Boolean(value))
    for (const credential of credentials) detail = detail.replaceAll(credential, '[redacted]')
    // Azure can echo the complete JSON settings file; its contents are never diagnostic output.
    if (args.includes('appsettings')) detail = 'Could not apply application settings.'
    throw new Error(
      `${command} ${args.slice(0, 2).join(' ')} failed (exit ${outcome.code}).\n${detail.slice(-2000)}`,
    )
  }
  return outcome.stdout.trim()
}
