import type {
  AutomationIdentity,
  AutomationPlatform,
  AutomationRun,
  AutomationSchedule,
  AutomationScope,
} from './types.js'

export interface DurableCommand {
  action: string
  input: Record<string, unknown>
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function readDurableCommand(value: unknown): DurableCommand | null {
  if (!record(value) || typeof value.action !== 'string' || !record(value.input)) return null
  return { action: value.action, input: value.input }
}
function scopeFrom(value: unknown): AutomationScope | null {
  if (
    !record(value) ||
    typeof value.workspace !== 'string' ||
    !value.workspace ||
    value.workspace.length > 200
  ) {
    return null
  }
  const ownerId = value.ownerId
  if (
    ownerId !== null &&
    (typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId) || ownerId < 1)
  ) {
    return null
  }
  return { ownerId, workspace: value.workspace }
}
function identityFrom(value: Record<string, unknown>): AutomationIdentity | null {
  const scope = scopeFrom(value.scope)
  return scope && typeof value.runId === 'string' ? { scope, runId: value.runId } : null
}
function runFrom(value: unknown): AutomationRun | null {
  if (!record(value)) return null
  const identity = identityFrom(value)
  return identity && typeof value.task === 'string'
    ? { ...identity, task: value.task, payload: value.payload }
    : null
}
function scheduleFrom(value: unknown): AutomationSchedule | null {
  if (
    !record(value) ||
    !record(value.run) ||
    typeof value.cron !== 'string' ||
    typeof value.timeZone !== 'string'
  ) {
    return null
  }
  const run = runFrom({ ...value.run, runId: 'schedule-validation' })
  return run
    ? {
        cron: value.cron,
        timeZone: value.timeZone,
        run: { scope: run.scope, task: run.task, payload: run.payload },
      }
    : null
}

/** Shared private transport parsing; authorization remains in the task host and authenticated gateway. */
export async function executeAutomationCommand(
  platform: AutomationPlatform,
  command: DurableCommand,
): Promise<{ status: number; value: unknown }> {
  const { action, input } = command
  if (action === 'configure') {
    if (!record(input.schedules)) return { status: 400, value: null }
    const schedules: Record<string, AutomationSchedule> = {}
    for (const [name, value] of Object.entries(input.schedules)) {
      const schedule = scheduleFrom(value)
      if (!schedule) return { status: 400, value: null }
      Object.defineProperty(schedules, name, { value: schedule, enumerable: true })
    }
    await platform.configure(schedules)
    return { status: 200, value: null }
  }
  if (action === 'schedule') {
    const schedule = input.value === null ? null : scheduleFrom(input.value)
    if (typeof input.key !== 'string' || (input.value !== null && !schedule)) {
      return { status: 400, value: null }
    }
    await platform.schedule(input.key, schedule)
    return { status: 200, value: null }
  }
  const identity = identityFrom(input)
  if (!identity) return { status: 400, value: null }
  const runs = await platform.runs(identity.scope)
  if (action === 'start') {
    const request = runFrom(input)
    if (!request) return { status: 400, value: null }
    return { status: 200, value: await runs.start(request) }
  }
  if (action === 'status') return { status: 200, value: await runs.status(identity.runId) }
  if (action === 'resume') await runs.resume(identity.runId)
  else if (action === 'cancel') await runs.cancel(identity.runId)
  else if (action === 'signal' && typeof input.event === 'string') {
    await runs.signal(identity.runId, input.event, input.payload)
  } else return { status: 400, value: null }
  return { status: 200, value: null }
}
