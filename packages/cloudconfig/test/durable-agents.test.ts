import { afterEach, expect, it, vi } from 'vitest'
import { createAgentDefinition } from '../src/agents/definition.js'
import {
  createDurableAgentPlatform,
  durableAgentRuntime,
  type NativeAgentDispatcher,
} from '../src/agents/durable.js'
import type { AgentRecordStore } from '../src/agents/records.js'
import type { AgentRunHost } from '../src/agents/runs.js'

function records(): AgentRecordStore {
  const values = new Map<string, { value: string; version: string }>()
  return {
    async read(key) {
      return structuredClone(values.get(key) ?? null)
    },
    async create(key, value) {
      if (values.has(key)) return false
      values.set(key, { value, version: crypto.randomUUID() })
      return true
    },
    async replace(key, value, version) {
      if (values.get(key)?.version !== version) return false
      values.set(key, { value, version: crypto.randomUUID() })
      return true
    },
  }
}

const scope = { ownerId: 1, workspace: 'personal', agentId: 2, sessionId: 'session' }
const request = { runId: 'native-run', scope, payload: {}, instructions: 'Act' }
const tool = { name: 'action', description: 'Action', parameters: { type: 'object' } }

function fixture() {
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: { type?: string }[] }
    return Response.json(
      body.input.some((item) => item.type === 'function_call_output')
        ? { output: [{ content: [{ type: 'output_text', text: 'Finished' }] }] }
        : { output: [{ type: 'function_call', name: 'action', call_id: 'c', arguments: '{}' }] },
    )
  })
  const callTool = vi.fn(async (): Promise<unknown> => ({ ok: true }))
  const scheduled = vi.fn(async () => {})
  const host: AgentRunHost<undefined> = {
    async resolve() {
      return {
        agent: { ...createAgentDefinition('Native'), provider: 'openai' },
        keys: { openai: 'private-key', anthropic: '', google: '' },
        tools: [tool],
        fetch,
        callTool,
      }
    },
    scheduled,
  }
  const store = records()
  const runtime = () => durableAgentRuntime({ host, records: store, env: undefined })
  return { runtime, host, store, fetch, callTool, scheduled }
}

afterEach(() => vi.useRealTimers())

it('continues bounded activities after a process restart and never repeats completed model or tool calls', async () => {
  const { runtime, fetch, callTool } = fixture()
  expect(await runtime().start(request)).toMatchObject({ status: 'queued' })
  expect(await runtime().tick(request)).toMatchObject({ status: 'queued' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(callTool).not.toHaveBeenCalled()
  expect(await runtime().tick(request)).toMatchObject({ status: 'queued' })
  expect(callTool).toHaveBeenCalledTimes(1)
  expect(await runtime().tick(request)).toMatchObject({ status: 'succeeded', output: 'Finished' })
  expect(await runtime().tick(request)).toMatchObject({ status: 'succeeded' })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(callTool).toHaveBeenCalledTimes(1)
})

it('uses a durable lease to prevent concurrent workers from executing the same model call', async () => {
  const { runtime, fetch } = fixture()
  let finish: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  fetch.mockImplementationOnce(async () => {
    await pending
    return Response.json({ output: [{ content: [{ type: 'output_text', text: 'Finished' }] }] })
  })
  await runtime().start(request)
  const first = runtime().tick(request)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  expect(await runtime().tick(request)).toMatchObject({ status: 'running' })
  finish!()
  expect(await first).toMatchObject({ status: 'succeeded' })
  expect(fetch).toHaveBeenCalledOnce()
})

it('keeps approval waits outside activities and resumes without replaying the original action', async () => {
  const { runtime, host, callTool } = fixture()
  callTool.mockResolvedValue({ approvalRequired: true, approvalId: 7 })
  let approved = false
  host.approval = async () => (approved ? { ok: true } : { approvalRequired: true, approvalId: 7 })
  await runtime().start(request)
  await runtime().tick(request)
  expect(await runtime().tick(request)).toMatchObject({ status: 'waiting', approvalId: 7 })
  approved = true
  expect(await runtime().tick(request)).toMatchObject({ status: 'queued' })
  expect(await runtime().tick(request)).toMatchObject({ status: 'succeeded' })
  expect(callTool).toHaveBeenCalledOnce()
})

it('starts one native execution for retried requests and wakes it after approval', async () => {
  const { host, store } = fixture()
  const dispatcher: NativeAgentDispatcher = {
    startRun: vi.fn(async () => 'execution-1'),
    startSchedule: vi.fn(async () => 'schedule-1'),
    isActive: vi.fn(async () => true),
    wake: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  }
  const platform = () =>
    createDurableAgentPlatform({ host, records: store, env: undefined, dispatcher })
  const runs = await platform().runs(scope)
  await runs.start(request)
  await (await platform().runs(scope)).start(request)
  expect(dispatcher.startRun).toHaveBeenCalledOnce()
  await runs.resume(request.runId)
  expect(dispatcher.wake).toHaveBeenCalledExactlyOnceWith('execution-1')
  expect(await (await platform().runs({ ...scope, ownerId: 9 })).status(request.runId)).toBeNull()
  await expect((await platform().runs({ ...scope, ownerId: 9 })).start(request)).rejects.toThrow(
    'opened for',
  )
})

it('recovers a failed native execution using its persisted checkpoints', async () => {
  const { host, store } = fixture()
  const dispatcher: NativeAgentDispatcher = {
    startRun: vi.fn(async () => crypto.randomUUID()),
    startSchedule: vi.fn(async () => 'schedule'),
    isActive: vi.fn(async () => false),
    wake: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  }
  const platform = createDurableAgentPlatform({ host, records: store, env: undefined, dispatcher })
  const runs = await platform.runs(scope)
  await runs.start(request)
  await runs.resume(request.runId)
  expect(dispatcher.startRun).toHaveBeenCalledTimes(2)
})

it('persists cron schedules across restarts and fences cancelled generations', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-15T10:00:30Z') })
  const { runtime, scheduled } = fixture()
  const schedule = await runtime().replaceSchedule('automation:1', {
    cron: '* * * * *',
    timeZone: 'UTC',
    payload: { id: 1 },
  })
  expect(schedule.dueAt).toBe('2026-10-15T10:01:00.000Z')
  const tick = { ...schedule, dueAt: schedule.dueAt! }
  vi.setSystemTime(new Date('2026-10-15T10:01:00Z'))
  await runtime().fire(tick)
  await runtime().fire(tick)
  expect(scheduled).toHaveBeenCalledExactlyOnceWith(
    { id: 1 },
    '2026-10-15T10:01:00.000Z',
    undefined,
  )
  expect(await runtime().schedule(schedule)).toMatchObject({ dueAt: '2026-10-15T10:02:00.000Z' })
  // A delayed retry belongs to the original occurrence, even when the next one is now due.
  vi.setSystemTime(new Date('2026-10-15T10:02:00Z'))
  await runtime().fire(tick)
  expect(scheduled).toHaveBeenCalledOnce()
  await runtime().replaceSchedule('automation:1', null)
  await runtime().fire({ ...tick, dueAt: '2026-10-15T10:02:00.000Z' })
  expect(scheduled).toHaveBeenCalledOnce()
  expect(await runtime().schedule(schedule)).toBeNull()
})

it('keeps the current schedule execution when a stale continuation finishes tracking', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-15T10:00:30Z') })
  const { runtime } = fixture()
  const value = { cron: '* * * * *', timeZone: 'UTC', payload: {} }
  const first = await runtime().replaceSchedule('automation:1', value)
  await runtime().trackSchedule(first, 'initial', first.dueAt)
  vi.setSystemTime(new Date('2026-10-15T10:01:00Z'))
  await runtime().fire({ ...first, dueAt: first.dueAt! })
  const next = (await runtime().schedule(first))!
  await runtime().trackSchedule(next, 'continuation', next.dueAt)
  await runtime().trackSchedule(first, 'stale', first.dueAt)
  expect(await runtime().schedule(first)).toMatchObject({ executionId: 'continuation' })

  const replaced = await runtime().replaceSchedule('automation:1', value)
  await runtime().trackSchedule(next, 'obsolete', next.dueAt)
  expect(await runtime().schedule(replaced)).not.toHaveProperty('executionId')
})

it('does not repeat an ambiguous scheduled side effect after an interrupted activity', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-15T10:00:30Z') })
  const { runtime, scheduled } = fixture()
  scheduled.mockRejectedValue(new Error('Interrupted after dispatch'))
  const schedule = await runtime().replaceSchedule('automation:1', {
    cron: '* * * * *',
    timeZone: 'UTC',
    payload: {},
  })
  const tick = { ...schedule, dueAt: schedule.dueAt! }
  vi.setSystemTime(new Date('2026-10-15T10:01:00Z'))
  await expect(runtime().fire(tick)).rejects.toThrow('Interrupted after dispatch')
  await expect(runtime().fire(tick)).rejects.toThrow('interrupted')
  expect(scheduled).toHaveBeenCalledOnce()
})
