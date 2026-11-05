import { afterEach, expect, it, vi } from 'vitest'
import { azureAgentPlatform } from '../src/agents/azure-client.js'

const scope = { ownerId: 1, workspace: 'personal', agentId: 2, sessionId: 'session' }
const env = {
  CLOUDCONFIG_AZURE_AGENT_ENDPOINT: 'https://agents.azurewebsites.net/api/cloudconfig/agents',
  CLOUDCONFIG_AZURE_AGENT_KEY: 'server-only-key',
}
afterEach(() => vi.unstubAllGlobals())

it('sends scoped native operations with a server-only Function key', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ runId: 'run', status: 'queued', output: '', error: '' }),
  )
  vi.stubGlobal('fetch', fetch)
  const runs = await azureAgentPlatform(env).runs(scope)
  await runs.start({ runId: 'run', scope, payload: {}, instructions: 'Act' })
  expect(fetch).toHaveBeenCalledWith(
    env.CLOUDCONFIG_AZURE_AGENT_ENDPOINT,
    expect.objectContaining({
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-functions-key': 'server-only-key' },
    }),
  )
  await expect(
    runs.start({
      runId: 'other',
      scope: { ...scope, ownerId: 9 },
      payload: {},
      instructions: 'Act',
    }),
  ).rejects.toThrow('opened for')
  expect(fetch).toHaveBeenCalledOnce()
})

it('fails without native execution credentials and never falls back to process memory', async () => {
  const runs = await azureAgentPlatform({
    CLOUDCONFIG_AZURE_AGENT_ENDPOINT: env.CLOUDCONFIG_AZURE_AGENT_ENDPOINT,
  }).runs(scope)
  await expect(runs.status('run')).rejects.toThrow('CLOUDCONFIG_AZURE_AGENT_KEY')
})
