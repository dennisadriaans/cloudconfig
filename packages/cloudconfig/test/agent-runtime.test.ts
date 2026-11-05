import { describe, expect, it, vi } from 'vitest'
import { createAgentDefinition } from '../src/agents/definition.js'
import { runSavedAgent, type AgentCheckpoint } from '../src/agents/runtime.js'
import { agentInstanceName, nextAgentSchedule } from '../src/agents/schedules.js'
import {
  reconcileAgentBindings,
  assertWorkerExports,
} from '../src/cli/cloudflare/agent-bindings.js'
import { workerExports } from '../src/shared/worker-exports.js'

const tool = {
  name: 'search',
  description: 'Search',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
}
const keys = { openai: 'test', anthropic: 'test', google: 'test' }
function invocation() {
  return {
    agent: { ...createAgentDefinition(), provider: 'openai' as const },
    instructions: 'Search',
    payload: { query: 'test' },
    keys,
    tools: [tool],
    signal: AbortSignal.timeout(10_000),
    runId: 'run-1',
  }
}
/** Each provider's wire format for one tool call followed by a final answer. */
const PROVIDER_RESPONSES = {
  openai: [
    {
      output: [
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'search',
          arguments: '{"query":"test"}',
        },
      ],
    },
    { output: [{ content: [{ type: 'output_text', text: 'Found it' }] }] },
  ],
  anthropic: [
    {
      content: [{ type: 'tool_use', id: 'call-1', name: 'search', input: { query: 'test' } }],
    },
    { content: [{ type: 'text', text: 'Found it' }] },
  ],
  google: [
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                thoughtSignature: 'signature',
                functionCall: { name: 'search', args: { query: 'test' } },
              },
            ],
          },
        },
      ],
    },
    { candidates: [{ content: { parts: [{ text: 'Found it' }] } }] },
  ],
}

it.each(['openai', 'anthropic', 'google'] as const)(
  'runs %s model/tool/model with replayable checkpoints',
  async (provider) => {
    const results = [...PROVIDER_RESPONSES[provider]]
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(results.shift())),
    )
    const checkpoints = new Map<string, unknown>()
    const checkpoint: AgentCheckpoint = async (name, callback) => {
      if (checkpoints.has(name)) return checkpoints.get(name) as never
      const value = await callback()
      checkpoints.set(name, value)
      return value
    }
    const receipts = new Map<string, unknown>()
    const dispatch = vi.fn(async () => ({ items: ['Found it'] }))
    const callTool = async (_name: string, _input: unknown, call: { callId: string }) => {
      if (!receipts.has(call.callId)) receipts.set(call.callId, await dispatch())
      return receipts.get(call.callId)
    }
    const options = {
      ...invocation(),
      agent: { ...invocation().agent, provider },
      fetch: fetcher,
      checkpoint,
      callTool,
    }
    expect(await runSavedAgent(options)).toBe('Found it')
    expect(await runSavedAgent(options)).toBe('Found it')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(1)
    if (provider === 'google') {
      expect(
        JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).contents[1].parts[0].thoughtSignature,
      ).toBe('signature')
    }
  },
)
it.each([
  { name: 'ungranted', arguments: '{"query":"test"}' },
  { name: 'search', arguments: '{"query":1}' },
])('rejects ungranted tools and malformed arguments before dispatch', async (call) => {
  const dispatch = vi.fn()
  await expect(
    runSavedAgent({
      ...invocation(),
      callTool: dispatch,
      fetch: async () =>
        new Response(JSON.stringify({ output: [{ type: 'function_call', ...call }] })),
    }),
  ).rejects.toThrow()
  expect(dispatch).not.toHaveBeenCalled()
})
it('rejects provider redirects without forwarding credentials', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('manual')
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example' } })
  })
  await expect(
    runSavedAgent({ ...invocation(), fetch: fetcher, callTool: vi.fn() }),
  ).rejects.toThrow('returned 302')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('isolates owners, workspaces, agents and sessions in instance names', async () => {
  const scope = { ownerId: 1, workspace: 'personal', agentId: 2, sessionId: 'test' }
  const names = await Promise.all(
    [
      scope,
      { ...scope, ownerId: 2 },
      { ...scope, workspace: 'team' },
      { ...scope, agentId: 3 },
      { ...scope, sessionId: 'another' },
    ].map(agentInstanceName),
  )
  expect(new Set(names).size).toBe(5)
  expect(await agentInstanceName(scope)).toBe(names[0])
})
it('schedules in an IANA time zone across DST and rejects invalid cron', () => {
  expect(
    nextAgentSchedule(
      '0 9 * * *',
      'Europe/Amsterdam',
      new Date('2026-10-24T08:00:00Z'),
    ).toISOString(),
  ).toBe('2026-10-25T08:00:00.000Z')
  expect(() => nextAgentSchedule('* * *', 'UTC')).toThrow()
  expect(() => nextAgentSchedule('0 9 * * *', 'Fake/Zone')).toThrow()
})
it('reconciles deployment idempotently while preserving unrelated bindings and migrations', () => {
  const text =
    '{\n// keep canvas\n"durable_objects":{"bindings":[{"name":"CANVAS","class_name":"CanvasRoom"}]}, "migrations":[{"tag":"canvas-v1","new_sqlite_classes":["CanvasRoom"]}]}'
  const deploy = {
    agents: [
      {
        entry: 'server/agent.ts',
        binding: 'AGENTS',
        className: 'AppAgent',
        migrationTag: 'agents-v1',
      },
    ],
    workflows: [
      { entry: 'server/workflow.ts', binding: 'RUNNER', className: 'Runner', name: 'app-runs' },
    ],
  }
  const result = reconcileAgentBindings(text, deploy)
  expect(reconcileAgentBindings(result, deploy)).toBe(result)
  expect(result).toContain('// keep canvas')
  expect(JSON.parse(result.replace('// keep canvas', '')).migrations).toHaveLength(2)
  expect(result).toContain('CanvasRoom')
  expect(() =>
    reconcileAgentBindings(result, {
      ...deploy,
      agents: [{ ...deploy.agents[0]!, className: 'Different' }],
    }),
  ).toThrow('conflicts')
  expect(() =>
    reconcileAgentBindings(result, {
      ...deploy,
      agents: [{ ...deploy.agents[0]!, migrationTag: 'changed-tag' }],
    }),
  ).toThrow('Keep its migrationTag unchanged')
  expect(() =>
    workerExports({ agents: [{ ...deploy.agents[0]!, entry: '../outside.ts' }] }),
  ).toThrow()
})

it('normalizes a portable agent host into stable Cloudflare exports and bindings', () => {
  const deploy = { agent: { entry: 'server/cloudconfig/agents.ts' } }
  expect(workerExports(deploy)).toEqual([
    {
      entry: 'server/cloudconfig/agents.ts',
      className: 'CloudconfigAgent',
      binding: 'CLOUDCONFIG_AGENTS',
      migrationTag: 'cloudconfig-agents-v1',
    },
  ])
  const output = reconcileAgentBindings('{}', deploy)
  expect(JSON.parse(output)).toMatchObject({
    durable_objects: { bindings: [{ name: 'CLOUDCONFIG_AGENTS', class_name: 'CloudconfigAgent' }] },
    migrations: [{ tag: 'cloudconfig-agents-v1', new_sqlite_classes: ['CloudconfigAgent'] }],
  })
})
it('checks the actual public Worker export name before migrating', () => {
  const deploy = {
    agents: [
      {
        entry: 'server/agent.ts',
        className: 'AppAgent$',
        binding: 'AGENTS',
        migrationTag: 'agents-v1',
      },
    ],
  }
  expect(() => assertWorkerExports('export class AppAgent$ {}', deploy)).not.toThrow()
  expect(() => assertWorkerExports('export { renamed as AppAgent$ };', deploy)).not.toThrow()
  expect(() => assertWorkerExports('export { AppAgent$ as Different };', deploy)).toThrow(
    'does not export',
  )
  expect(() => assertWorkerExports('export class AppAgent$Other {}', deploy)).toThrow(
    'does not export',
  )
})
it('preserves the agent migration while adding a separate native automation class', () => {
  const agents = { agent: { entry: 'server/agents.ts' } }
  const original = reconcileAgentBindings('{}', agents)
  const deploy = { ...agents, automations: { entry: 'server/automations.ts' } }
  const added = reconcileAgentBindings(original, deploy)
  expect(reconcileAgentBindings(added, deploy)).toBe(added)
  expect(JSON.parse(added)).toMatchObject({
    durable_objects: {
      bindings: [
        { name: 'CLOUDCONFIG_AGENTS', class_name: 'CloudconfigAgent' },
        { name: 'CLOUDCONFIG_AUTOMATIONS', class_name: 'CloudconfigAutomations' },
      ],
    },
    migrations: [
      { tag: 'cloudconfig-agents-v1', new_sqlite_classes: ['CloudconfigAgent'] },
      { tag: 'cloudconfig-automations-v1', new_sqlite_classes: ['CloudconfigAutomations'] },
    ],
  })
  expect(() => assertWorkerExports('export { CloudconfigAgent };', deploy)).toThrow(
    'does not export CloudconfigAutomations',
  )
  expect(() =>
    workerExports({
      ...deploy,
      automations: { ...deploy.automations, cloudflare: { binding: 'CLOUDCONFIG_AGENTS' } },
    }),
  ).toThrow('unique')
})
it('honors run cancellation alongside a fresh per-call deadline', async () => {
  const signals: AbortSignal[] = []
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init!.signal!)
    return new Response(
      JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'Done' }] }] }),
    )
  })
  const controller = new AbortController()
  const { signal: _signal, ...rest } = invocation()
  await runSavedAgent({
    ...rest,
    signal: controller.signal,
    timeoutMs: 60_000,
    fetch: fetcher,
    callTool: vi.fn(),
  })
  expect(signals[0]!.aborted).toBe(false)
  controller.abort()
  expect(signals[0]!.aborted).toBe(true)
  await runSavedAgent({ ...rest, timeoutMs: 60_000, fetch: fetcher, callTool: vi.fn() })
  expect(signals[1]).toBeInstanceOf(AbortSignal)
})
describe('transient provider failures', () => {
  const finished = () =>
    new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'Done' }] }] }))
  const failure = (status: number, retryAfter = '0') =>
    new Response('Busy', { status, headers: { 'Retry-After': retryAfter } })

  it.each([429, 500, 503, 529])('retries status %i and then succeeds', async (status) => {
    const responses = [failure(status), finished()]
    const fetcher = vi.fn(async () => responses.shift()!)
    expect(await runSavedAgent({ ...invocation(), fetch: fetcher, callTool: vi.fn() })).toBe('Done')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('retries a dropped connection', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      if (calls++ === 0) throw new TypeError('fetch failed')
      return finished()
    })
    expect(await runSavedAgent({ ...invocation(), fetch: fetcher, callTool: vi.fn() })).toBe('Done')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('fails at once on errors that a retry cannot fix', async () => {
    const unauthorized = vi.fn(async () => new Response('No', { status: 401 }))
    await expect(
      runSavedAgent({ ...invocation(), fetch: unauthorized, callTool: vi.fn() }),
    ).rejects.toThrow('returned 401')
    expect(unauthorized).toHaveBeenCalledTimes(1)
    const broken = vi.fn(async () => {
      throw new Error('Invalid fixture')
    })
    await expect(
      runSavedAgent({ ...invocation(), fetch: broken, callTool: vi.fn() }),
    ).rejects.toThrow('Invalid fixture')
    expect(broken).toHaveBeenCalledTimes(1)
  })

  it('treats a long Retry-After as exhausted quota', async () => {
    const fetcher = vi.fn(async () => failure(429, '60'))
    await expect(
      runSavedAgent({ ...invocation(), fetch: fetcher, callTool: vi.fn() }),
    ).rejects.toThrow('returned 429')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('gives up after three retries', async () => {
    const fetcher = vi.fn(async () => failure(503))
    await expect(
      runSavedAgent({ ...invocation(), fetch: fetcher, callTool: vi.fn() }),
    ).rejects.toThrow('returned 503')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('keeps retries and waits inside the per-call deadline', async () => {
    const fetcher = vi.fn(async () => failure(503, '5'))
    const { signal: _signal, ...rest } = invocation()
    const started = Date.now()
    await expect(
      runSavedAgent({ ...rest, timeoutMs: 100, fetch: fetcher, callTool: vi.fn() }),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
