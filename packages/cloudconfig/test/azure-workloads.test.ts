import { afterEach, expect, it, vi } from 'vitest'
import { createAgentDefinition } from '../src/agents/definition.js'
import type { AgentRunRequest } from '../src/agents/runs.js'
import { getAgentPlatform, provideAgentPlatform } from '../src/agents/platform.js'
import { getAutomationPlatform, provideAutomationPlatform } from '../src/automations/platform.js'
import { registerAzureWorkloads } from '../src/durable/azure.js'

const native = vi.hoisted(() => ({
  activities: new Map<
    string,
    { extraInputs: unknown[]; handler: (input: unknown, context: unknown) => Promise<unknown> }
  >(),
  routes: new Map<
    string,
    {
      authLevel: string
      handler: (request: { json: () => Promise<unknown> }, context: unknown) => Promise<unknown>
    }
  >(),
  values: new Map<string, { value: string; version: string }>(),
  getClient: vi.fn(),
}))
vi.mock('@azure/functions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@azure/functions')>()),
  app: {
    http: (name: string, options: Parameters<typeof native.routes.set>[1]) =>
      native.routes.set(name, options),
  },
}))
vi.mock('durable-functions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('durable-functions')>()),
  app: {
    activity: (name: string, options: Parameters<typeof native.activities.set>[1]) =>
      native.activities.set(name, options),
    orchestration: vi.fn(),
  },
  getClient: native.getClient,
}))
vi.mock('../src/durable/azure-records.js', () => ({
  azureExecutionRecords: () => ({
    read: async (key: string) => structuredClone(native.values.get(key) ?? null),
    create: async (key: string, value: string) => {
      if (native.values.has(key)) return false
      native.values.set(key, { value, version: crypto.randomUUID() })
      return true
    },
    replace: async (key: string, value: string, version: string) => {
      if (native.values.get(key)?.version !== version) return false
      native.values.set(key, { value, version: crypto.randomUUID() })
      return true
    },
  }),
}))

afterEach(() => {
  provideAgentPlatform(undefined)
  provideAutomationPlatform(undefined)
  vi.unstubAllEnvs()
  native.activities.clear()
  native.routes.clear()
  native.values.clear()
})

it('binds both native ports to the current Function invocation for cross-workload callbacks', async () => {
  vi.stubEnv('AzureWebJobsStorage', 'private-storage')
  vi.stubEnv('PRIVATE_SETTING', 'server-only')
  const startNew = vi.fn(async (_name: string, _options: unknown) => crypto.randomUUID())
  native.getClient.mockReturnValue({ startNew, getStatus: vi.fn() })
  const resolve = vi.fn(async (_request: AgentRunRequest, env: NodeJS.ProcessEnv) => {
    expect(env.PRIVATE_SETTING).toBe('server-only')
    return {
      agent: createAgentDefinition('Fixture'),
      keys: { openai: '', anthropic: '', google: '' },
      tools: [],
      callTool: async () => null,
    }
  })
  registerAzureWorkloads({
    agent: { resolve },
    automations: {
      async authorize() {},
      tasks: {
        async process(_payload, context) {
          const scope = { ownerId: 1, workspace: 'personal', agentId: 2, sessionId: 'fixture' }
          return context.step('enqueue-agent', async () => {
            const platform = getAgentPlatform(context.env)!
            return (await platform.runs(scope)).start({
              runId: 'agent',
              scope,
              payload: {},
              instructions: 'Act',
            })
          })
        },
      },
    },
  })
  expect(native.routes.get('cloudconfigAutomations')!.authLevel).toBe('function')
  expect(native.activities.get('cloudconfigAutomationTick')!.extraInputs).toHaveLength(1)
  expect(native.activities.get('cloudconfigAgentTick')!.extraInputs).toHaveLength(1)
  const request = {
    scope: { ownerId: 1, workspace: 'personal' },
    runId: 'job',
    task: 'process',
    payload: {},
  }
  const invocation = { invocationId: 'fixture' }
  const accepted = await native.routes.get('cloudconfigAutomations')!.handler(
    {
      json: async () => ({ action: 'start', input: request }),
    },
    invocation,
  )
  expect(accepted).toMatchObject({ status: 200, jsonBody: { status: 'queued' } })
  expect(
    await native.activities.get('cloudconfigAutomationTick')!.handler(request, invocation),
  ).toMatchObject({ status: 'succeeded' })
  expect(startNew.mock.calls.map(([name]) => name)).toEqual([
    'cloudconfigAutomationRun',
    'cloudconfigAgentRun',
  ])
  expect(resolve).toHaveBeenCalled()
  expect(() => getAutomationPlatform()).toThrow('Pass the activity environment')
})
