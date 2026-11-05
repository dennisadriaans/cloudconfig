import { afterEach, expect, it, vi } from 'vitest'
import { automationRunKey } from '../src/automations/identity.js'
import { automationRuntime } from '../src/automations/runtime.js'
import { automationService, type AutomationDispatcher } from '../src/automations/service.js'
import { defineAutomationHost, type AutomationHost } from '../src/automations/types.js'
import type { DurableRecordStore } from '../src/durable/records.js'

function records(): DurableRecordStore {
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
const scope = { ownerId: 1, workspace: 'personal' }
const request = { scope, runId: 'run-1', task: 'process', payload: { id: 5 } }

function fixture(host: AutomationHost<undefined>) {
  const store = records()
  const dispatcher: AutomationDispatcher = {
    startRun: vi.fn(async () => crypto.randomUUID()),
    startSchedule: vi.fn(async () => crypto.randomUUID()),
    isActive: vi.fn(async () => true),
    wake: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  }
  const service = () => automationService({ host, records: store, env: undefined, dispatcher })
  const runtime = () => automationRuntime({ host, records: store, env: undefined })
  return { store, service, runtime, dispatcher }
}

afterEach(() => vi.useRealTimers())

it('replays named steps across restarts without repeating completed actions or changing void results', async () => {
  const first = vi.fn(async () => undefined)
  const second = vi.fn(async () => 'finished')
  const host = defineAutomationHost<undefined>({
    authorize: async () => {},
    tasks: {
      async process(_payload, context) {
        const initial = await context.step('first', first)
        expect(initial).toBeUndefined()
        return context.step('second', second)
      },
    },
  })
  const { runtime } = fixture(host)
  await runtime().start(request)
  expect(await runtime().tick(request)).toMatchObject({ status: 'queued' })
  expect(await runtime().tick(request)).toMatchObject({ status: 'succeeded', output: 'finished' })
  expect(await runtime().tick(request)).toMatchObject({ status: 'succeeded' })
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
})

it('persists sleep deadlines and buffers an event once across native continuations', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-15T00:00:00Z') })
  const host = defineAutomationHost<undefined>({
    authorize: async () => {},
    tasks: {
      async process(_payload, context) {
        await context.sleep('delay', 5000)
        return context.waitForEvent('approved')
      },
    },
  })
  const { runtime } = fixture(host)
  await runtime().start(request)
  expect(await runtime().tick(request)).toMatchObject({
    status: 'waiting',
    wakeAt: '2026-10-15T00:00:05.000Z',
  })
  vi.advanceTimersByTime(5000)
  expect(await runtime().tick(request)).toMatchObject({ status: 'waiting', waitingFor: 'approved' })
  await runtime().signal(request, 'approved', { approved: true })
  await runtime().signal(request, 'approved', { approved: false })
  expect(await runtime().tick(request)).toMatchObject({
    status: 'succeeded',
    output: { approved: true },
  })
})

it('retries explicitly idempotent actions with a stable key and durable backoff', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-15T00:00:00Z') })
  const action = vi
    .fn()
    .mockRejectedValueOnce(new Error('Temporary outage'))
    .mockResolvedValue('accepted')
  const host = defineAutomationHost<undefined>({
    authorize: async () => {},
    tasks: {
      process: (_payload, context) =>
        context.step('send', action, { idempotent: true, attempts: 3, retryDelayMs: 5000 }),
    },
  })
  const { runtime } = fixture(host)
  await runtime().start(request)
  expect(await runtime().tick(request)).toMatchObject({
    status: 'waiting',
    wakeAt: '2026-10-15T00:00:05.000Z',
  })
  await runtime().tick(request)
  expect(action).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(5000)
  expect(await runtime().tick(request)).toMatchObject({ status: 'succeeded', output: 'accepted' })
  expect(action.mock.calls[0]![0].idempotencyKey).toBe(action.mock.calls[1]![0].idempotencyKey)
  expect(action.mock.calls[1]![0]).toMatchObject({ attempt: 2, signal: expect.any(AbortSignal) })
})

it('stops an interrupted external dispatch for review instead of repeating it', async () => {
  const action = vi.fn(async () => 'sent')
  const host = defineAutomationHost<undefined>({
    authorize: async () => {},
    tasks: { process: (_payload, context) => context.step('send', action) },
  })
  const { runtime, store } = fixture(host)
  await runtime().start(request)
  await store.create(
    `${await automationRunKey(request)}:step:send`,
    JSON.stringify({ status: 'started', attempt: 1 }),
  )
  expect(await runtime().tick(request)).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('Review its external result'),
  })
  expect(action).not.toHaveBeenCalled()
})

it('fences distributed execution and cancellation while an action is in flight', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const action = vi.fn(async () => {
    await pending
    return 'sent'
  })
  const host = defineAutomationHost<undefined>({
    authorize: async () => {},
    tasks: { process: (_payload, context) => context.step('send', action) },
  })
  const { runtime } = fixture(host)
  await runtime().start(request)
  const first = runtime().tick(request)
  await vi.waitFor(() => expect(action).toHaveBeenCalledOnce())
  expect(await runtime().tick(request)).toMatchObject({ status: 'running' })
  await runtime().cancel(request)
  finish()
  expect(await first).toMatchObject({ status: 'cancelled' })
  expect(await runtime().tick(request)).toMatchObject({ status: 'cancelled' })
  expect(action).toHaveBeenCalledOnce()
})

it('rechecks task permissions before every continuation', async () => {
  let isAllowed = true
  const action = vi.fn(async () => 'sent')
  const host = defineAutomationHost<undefined>({
    async authorize() {
      if (!isAllowed) throw new Error('Permission revoked')
    },
    tasks: { process: (_payload, context) => context.step('send', action) },
  })
  const { runtime } = fixture(host)
  await runtime().start(request)
  isAllowed = false
  expect(await runtime().tick(request)).toMatchObject({
    status: 'failed',
    error: 'Permission revoked',
  })
  expect(action).not.toHaveBeenCalled()
  await expect(runtime().status(request)).rejects.toThrow('Permission revoked')
})

it('deduplicates accepted requests, signals active native executions, and isolates scopes', async () => {
  const host = defineAutomationHost<undefined>({
    authorize: async () => {},
    tasks: { process: async () => null },
  })
  const { service, dispatcher } = fixture(host)
  const runs = await service().platform.runs(scope)
  await runs.start(request)
  await (await service().platform.runs(scope)).start(request)
  expect(dispatcher.startRun).toHaveBeenCalledOnce()
  await runs.signal(request.runId, 'approved', true)
  expect(dispatcher.wake).toHaveBeenCalledOnce()
  const other = await service().platform.runs({ ...scope, ownerId: 2 })
  expect(await other.status(request.runId)).toBeNull()
  await expect(other.start(request)).rejects.toThrow('opened for')
})

it('keeps static schedules stable across deploys and enqueues one run per occurrence', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-15T00:00:30Z') })
  const host = defineAutomationHost<undefined>({
    authorize: async () => {},
    tasks: { process: async () => null },
  })
  const { service, dispatcher } = fixture(host)
  const schedule = {
    cron: '* * * * *',
    timeZone: 'UTC',
    run: { scope, task: 'process', payload: {} },
  }
  await service().platform.configure({ hourly: schedule })
  await service().platform.configure({ hourly: schedule })
  expect(dispatcher.startSchedule).toHaveBeenCalledOnce()
  const identity = vi.mocked(dispatcher.startSchedule).mock.calls[0]![0]
  const current = (await service().schedule(identity))!
  vi.setSystemTime(new Date(current.dueAt!))
  await service().fire({ ...identity, dueAt: current.dueAt! })
  await service().fire({ ...identity, dueAt: current.dueAt! })
  expect(dispatcher.startRun).toHaveBeenCalledOnce()
  await service().platform.schedule('user-defined', schedule)
  await service().platform.configure({})
  expect(dispatcher.cancel).toHaveBeenCalledOnce()
  expect(await service().schedule(identity)).toBeNull()
})
