/**
 * Child-process adapter shared by CLI integrations.
 *
 * Kept separate from the wrangler wrappers so tests can stub one runner
 * instead of intercepting every command string.
 */
import { spawn } from 'node:child_process'
import { withLocalBin } from './local-bin.js'

export interface RunOptions {
  cwd: string
  /** Written to the child's stdin. Used for secrets, which must never appear in argv. */
  input?: string
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a command, capturing output. Never throws on a non-zero exit. */
export function run(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...withLocalBin(opts.cwd), ...opts.env },
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }
  })
}

/** Run a command with the parent's stdio, for output the user should watch live. */
export function runInherit(command: string, args: string[], opts: RunOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...withLocalBin(opts.cwd), ...opts.env },
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** Combined output — wrangler splits messages across both streams inconsistently. */
export function output(result: RunResult): string {
  return `${result.stdout}\n${result.stderr}`
}
