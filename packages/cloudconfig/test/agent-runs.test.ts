import { expect, it } from 'vitest'
import { createAgentDefinition } from '../src/agents/definition.js'
import {
  createAgentRunner,
  createMemoryAgentRunStore,
  type AgentRunHost,
  type AgentRunRequest,
} from '../src/agents/runs.js'

const tool = { name: 'action', description: 'Action', parameters: { type: 'object' } }
const request: AgentRunRequest = {
  runId: 'run-1',
  scope: { ownerId: 1, workspace: 'personal', agentId: 2, sessionId: 'test' },
  payload: {},
  instructions: 'Act',
}

/** One tool round, then a final answer; counts provider and external calls. */
function fixture(dispatchResult: () => unknown, approval?: () => unknown) {
  const calls = { model: 0, tool: 0 }
  const host: AgentRunHost<null> = {
    async resolve() {
      return {
        agent: { ...createAgentDefinition('Fixture'), provider: 'openai' },
        keys: { openai: 'key', anthropic: '', google: '' },
        tools: [tool],
        fetch: async (_url, init) => {
          calls.model++
          const body = JSON.parse(String(init?.body)) as { input: { type?: string }[] }
          return Response.json(
            body.input.some((item) => item.type === 'function_call_output')
              ? { output: [{ content: [{ type: 'output_text', text: 'Finished' }] }] }
              : {
                  output: [
                    { type: 'function_call', name: 'action', call_id: 'c', arguments: '{}' },
                  ],
                },
          )
        },
        callTool: async () => {
          calls.tool++
          return dispatchResult()
        },
      }
    },
    ...(approval ? { approval: async () => approval() } : {}),
  }
  const store = createMemoryAgentRunStore()
  const dispatched: string[] = []
  const runner = createAgentRunner({
    host,
    store,
    env: null,
    dispatch: (runId) => void dispatched.push(runId),
  })
  return { runner, store, calls, dispatched }
}

it('accepts a run idempotently and completes it on dispatch', async () => {
  const { runner, calls, dispatched } = fixture(() => ({ ok: true }))
  expect((await runner.start(request)).status).toBe('queued')
  expect((await runner.start(request)).status).toBe('queued')
  expect(dispatched).toEqual(['run-1'])
  await runner.resume('run-1')
  await runner.resume('run-1')
  expect(await runner.status('run-1')).toMatchObject({ status: 'succeeded', output: 'Finished' })
  expect(calls).toEqual({ model: 2, tool: 1 })
  await expect(runner.start({ ...request, runId: 'bad id' })).rejects.toThrow('valid run ID')
})

it('pauses for approval and resumes from the actual approved result', async () => {
  let decision: unknown = { approvalRequired: true, approvalId: 7 }
  const { runner, calls } = fixture(
    () => ({ approvalRequired: true, approvalId: 7 }),
    () => decision,
  )
  await runner.start(request)
  await runner.resume('run-1')
  expect(await runner.status('run-1')).toMatchObject({ status: 'waiting', approvalId: 7 })
  await runner.resume('run-1')
  expect((await runner.status('run-1'))?.status).toBe('waiting')
  decision = { refunded: true }
  await runner.resume('run-1')
  const result = await runner.status('run-1')
  expect(result).toMatchObject({ status: 'succeeded', output: 'Finished' })
  expect(result).not.toHaveProperty('approvalId')
  // The first model round replays from its receipt; the tool never dispatches twice.
  expect(calls).toEqual({ model: 2, tool: 1 })
})

it('fails an interrupted external dispatch instead of repeating it', async () => {
  const { runner, store, calls } = fixture(() => ({ ok: true }))
  await runner.start(request)
  await store.setReceipt('run-1', 'tool 0-0', { status: 'started' })
  await runner.resume('run-1')
  expect(await runner.status('run-1')).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('interrupted after dispatch'),
  })
  expect(calls.tool).toBe(0)
})

it('ignores a concurrent resume of the same run', async () => {
  const { runner, calls } = fixture(() => ({ ok: true }))
  await runner.start(request)
  await Promise.all([runner.resume('run-1'), runner.resume('run-1')])
  expect(calls).toEqual({ model: 2, tool: 1 })
})
