import * as df from 'durable-functions'
import { expect, it, vi } from 'vitest'
import {
  azureAgentRun,
  azureAgentSchedule,
  type AgentOrchestrationContext,
} from '../src/agents/azure.js'
import { azureAutomationRun, azureAutomationSchedule } from '../src/automations/azure.js'

function contextFor(input: unknown) {
  const task: df.Task = { isCompleted: false, isFaulted: false }
  const timer: df.TimerTask = { ...task, isCanceled: false, cancel: vi.fn() }
  return {
    df: {
      getInput: vi.fn().mockReturnValue(input),
      callActivityWithRetry: vi.fn(() => task),
      setCustomStatus: vi.fn(),
      waitForExternalEvent: vi.fn(() => task),
      createTimer: vi.fn(() => timer),
      continueAsNew: vi.fn(),
      currentUtcDateTime: new Date('2026-10-15T00:00:00Z'),
    },
  } satisfies AgentOrchestrationContext
}

it('suspends approvals in the native orchestration and resumes through a new bounded activity', () => {
  const input = {
    scope: { ownerId: 1, workspace: 'personal', agentId: 2, sessionId: 'session' },
    runId: 'run',
  }
  const context = contextFor(input)
  const activity = vi.spyOn(context.df, 'callActivityWithRetry')
  const wait = vi.spyOn(context.df, 'waitForExternalEvent')
  const status = vi.spyOn(context.df, 'setCustomStatus')
  const run = azureAgentRun(context)
  run.next()
  expect(activity).toHaveBeenCalledWith('cloudconfigAgentTick', expect.any(df.RetryOptions), input)
  run.next({ runId: 'run', status: 'waiting', approvalId: 7, output: '', error: '' })
  expect(wait).toHaveBeenCalledWith('resume')
  run.next()
  expect(activity).toHaveBeenCalledTimes(2)
  const result = {
    runId: 'run',
    status: 'succeeded' as const,
    output: 'Generated text '.repeat(2_000),
    error: '',
  }
  expect(run.next(result)).toMatchObject({ done: true, value: result })
  expect(status).toHaveBeenLastCalledWith({ runId: 'run', status: 'succeeded' })
})

it('uses durable timers and continueAsNew so recurring schedules do not grow unbounded history', () => {
  const input = { key: 'automation:1', generation: 'generation' }
  const context = contextFor(input)
  const timer = vi.spyOn(context.df, 'createTimer')
  const next = vi.spyOn(context.df, 'continueAsNew')
  const schedule = azureAgentSchedule(context)
  schedule.next()
  schedule.next({
    ...input,
    value: { cron: '* * * * *', timeZone: 'UTC', payload: {} },
    dueAt: '2026-10-16T00:00:00Z',
  })
  expect(timer).toHaveBeenCalledWith(new Date('2026-10-16T00:00:00Z'))
  schedule.next()
  expect(context.df.callActivityWithRetry).toHaveBeenLastCalledWith(
    'cloudconfigAgentFireSchedule',
    expect.any(df.RetryOptions),
    { ...input, dueAt: '2026-10-16T00:00:00Z' },
  )
  expect(schedule.next()).toMatchObject({ done: true })
  expect(next).toHaveBeenCalledWith(input)
})

it('uses native automation delays and buffered event waits without putting results in custom status', () => {
  const input = { scope: { ownerId: null, workspace: 'system' }, runId: 'job' }
  const context = contextFor(input)
  const run = azureAutomationRun(context)
  run.next()
  expect(context.df.callActivityWithRetry).toHaveBeenCalledWith(
    'cloudconfigAutomationTick',
    expect.any(df.RetryOptions),
    input,
  )
  run.next({
    runId: 'job',
    status: 'waiting',
    output: null,
    error: '',
    wakeAt: '2026-10-16T12:00:00Z',
  })
  expect(context.df.createTimer).toHaveBeenCalledWith(new Date('2026-10-16T12:00:00Z'))
  run.next()
  run.next({ runId: 'job', status: 'waiting', output: null, error: '', waitingFor: 'approved' })
  expect(context.df.waitForExternalEvent).toHaveBeenCalledWith('resume')
  run.next()
  const result = {
    runId: 'job',
    status: 'succeeded' as const,
    output: 'large result '.repeat(2000),
    error: '',
  }
  expect(run.next(result)).toMatchObject({ done: true, value: result })
  expect(context.df.setCustomStatus).toHaveBeenLastCalledWith({
    runId: 'job',
    status: 'succeeded',
    wakeAt: undefined,
    waitingFor: undefined,
  })
})

it('continues automation schedules with a fenced occurrence and bounded orchestration history', () => {
  const input = { key: 'daily', generation: 'generation' }
  const context = contextFor(input)
  const schedule = azureAutomationSchedule(context)
  schedule.next()
  expect(context.df.callActivityWithRetry).toHaveBeenCalledWith(
    'cloudconfigAutomationNextSchedule',
    expect.any(df.RetryOptions),
    input,
  )
  schedule.next({
    ...input,
    kind: 'automation-schedule',
    dueAt: '2026-10-16T00:00:00Z',
    value: {
      cron: '0 0 * * *',
      timeZone: 'UTC',
      run: { scope: { ownerId: null, workspace: 'system' }, task: 'reconcile', payload: {} },
    },
  })
  expect(context.df.createTimer).toHaveBeenCalledWith(new Date('2026-10-16T00:00:00Z'))
  schedule.next()
  expect(context.df.callActivityWithRetry).toHaveBeenLastCalledWith(
    'cloudconfigAutomationFireSchedule',
    expect.any(df.RetryOptions),
    { ...input, dueAt: '2026-10-16T00:00:00Z' },
  )
  expect(schedule.next()).toMatchObject({ done: true })
  expect(context.df.continueAsNew).toHaveBeenCalledWith(input)
})
