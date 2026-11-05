import { afterEach, expect, it, vi } from 'vitest'
import { createAgentDefinition } from '../src/agents/definition.js'
import {
  createMemoryAgentPlatform,
  defineAgentHost,
  getAgentPlatform,
  provideAgentPlatform,
  type AgentPlatform,
} from '../src/agents/platform.js'

const scope = { ownerId: 1, workspace: 'personal', agentId: 2, sessionId: 'test' }
const host = defineAgentHost({
  async resolve() {
    return {
      agent: { ...createAgentDefinition('Fixture'), provider: 'openai' as const },
      keys: { openai: 'key', anthropic: '', google: '' },
      tools: [],
      fetch: async () =>
        Response.json({ output: [{ content: [{ type: 'output_text', text: 'Finished' }] }] }),
      callTool: async () => null,
    }
  },
})

async function settle(platform: AgentPlatform, runId: string) {
  const runs = await platform.runs(scope)
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await runs.status(runId)
    if (result?.status === 'succeeded' || result?.status === 'failed') return result
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('The run did not finish.')
}

afterEach(() => {
  provideAgentPlatform(undefined)
  vi.useRealTimers()
})

it('resolves the adapter bound by the composition root', () => {
  expect(getAgentPlatform()).toBeUndefined()
  const platform = createMemoryAgentPlatform(host)
  const factory = vi.fn(() => platform)
  provideAgentPlatform(factory)
  expect(getAgentPlatform({ BINDING: true })).toBe(platform)
  expect(factory).toHaveBeenCalledWith({ BINDING: true })
})

it('runs saved agents in the background and keeps runs inside their scope', async () => {
  const platform = createMemoryAgentPlatform(host)
  const runs = await platform.runs(scope)
  const request = { runId: 'run-1', scope, payload: {}, instructions: 'Act' }
  // Dispatch continues the run at once in this process, so it may already be running.
  expect(['queued', 'running']).toContain((await runs.start(request)).status)
  expect(await settle(platform, 'run-1')).toMatchObject({ status: 'succeeded', output: 'Finished' })
  await expect(
    runs.start({ ...request, runId: 'run-2', scope: { ...scope, ownerId: 9 } }),
  ).rejects.toThrow('opened for')
  expect(await (await platform.runs({ ...scope, ownerId: 9 })).status('run-1')).toBeNull()
})

it('lets the host replace the harness with the gateway context it stored', async () => {
  const execute = vi.fn(async () => 'Local result')
  const platform = createMemoryAgentPlatform({ ...host, execute })
  const runs = await platform.runs(scope)
  await runs.start({
    runId: 'local',
    scope,
    payload: {},
    instructions: 'Act',
    context: { cli: true },
  })
  expect(await settle(platform, 'local')).toMatchObject({ output: 'Local result' })
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ instructions: 'Act', timeoutMs: 120_000 }),
    expect.objectContaining({ context: { cli: true } }),
  )
})

it('fires in-process schedules at their cron time until cancelled', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-09T10:00:30Z') })
  const scheduled = vi.fn(async () => {})
  const platform = createMemoryAgentPlatform({ ...host, scheduled })
  await platform.schedule('automation:1', {
    cron: '* * * * *',
    timeZone: 'UTC',
    payload: { id: 1 },
  })
  await vi.advanceTimersByTimeAsync(29_000)
  expect(scheduled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(scheduled).toHaveBeenCalledWith({ id: 1 }, '2026-10-09T10:01:00.000Z', undefined)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(scheduled).toHaveBeenCalledTimes(2)
  await platform.schedule('automation:1', null)
  await vi.advanceTimersByTimeAsync(180_000)
  expect(scheduled).toHaveBeenCalledTimes(2)
  await expect(
    platform.schedule('automation:1', { cron: '* *', timeZone: 'UTC', payload: {} }),
  ).rejects.toThrow('five-field')
})
