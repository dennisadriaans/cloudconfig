import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { bundleWorker } from './helpers/worker-bundle.js'

it('persists real Cloudflare runs and concurrent schedule replacements across worker restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudconfig-worker-agents-'))
  const script = await bundleWorker(`
import { createCloudflareAgent } from './src/agents/cloudflare'
import { cloudflareAgentPlatform } from './src/agents/cloudflare-client'
import { createAgentDefinition } from './src/agents/definition'
import { agentStub, scheduleInstanceName } from './src/agents/schedules'
const Agent = createCloudflareAgent({
  async resolve() {
    return { agent: { ...createAgentDefinition('Fixture'), provider: 'openai' },
      keys: { openai: 'fixture', anthropic: '', google: '' }, tools: [],
      fetch: async () => Response.json({ output: [{ content: [{ type: 'output_text', text: 'Persisted result' }] }] }),
      callTool: async () => null }
  },
  async scheduled() {},
})
export class FixtureAgent extends Agent {
  pauseAlarm = false
  releaseAlarmWait
  pauseNextAlarm() { this.pauseAlarm = true }
  releaseAlarm() { this.releaseAlarmWait?.() }
  scheduleState() {
    const row = this.sql\`SELECT value FROM cc_schedule WHERE id = 1\`[0]
    return row ? JSON.parse(row.value) : null
  }
  async schedule(when, callback, payload, options) {
    if (this.pauseAlarm && callback === 'fireSchedule') {
      this.pauseAlarm = false
      await new Promise(resolve => { this.releaseAlarmWait = resolve })
    }
    return super.schedule(when, callback, payload, options)
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (path.startsWith('/schedule')) {
      const stub = await agentStub(env.AGENTS, await scheduleInstanceName('fixture'))
      if (path === '/schedule/pause') await stub.pauseNextAlarm()
      else if (path === '/schedule/release') await stub.releaseAlarm()
      else if (request.method === 'POST') await stub.setSchedule(await request.json())
      return Response.json(await stub.scheduleState())
    }
    const scope = { ownerId: 1, workspace: 'personal', agentId: 2, sessionId: 'fixture' }
    const runs = await cloudflareAgentPlatform(env.AGENTS).runs(scope)
    const result = request.method === 'POST'
      ? await runs.start({ runId: 'persistent-run', scope, payload: {}, instructions: 'Act' })
      : await runs.status('persistent-run')
    return Response.json(result)
  }
}`)
  const options = {
    name: 'cloudconfig-agent-fixture',
    modules: true,
    script,
    compatibilityDate: '2026-09-15',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { AGENTS: { className: 'FixtureAgent', useSQLite: true } },
    resourcePersistencePath: directory,
    log: new Log(LogLevel.ERROR),
  }
  let worker = new Miniflare(convertV4MiniflareOptions(options))
  try {
    const accepted = await worker.dispatchFetch('https://example.com', { method: 'POST' })
    expect(accepted.status).toBe(200)
    await vi.waitFor(
      async () => {
        const response = await worker.dispatchFetch('https://example.com')
        expect(await response.json()).toMatchObject({
          status: 'succeeded',
          output: 'Persisted result',
        })
      },
      { timeout: 15_000, interval: 100 },
    )
    await worker.dispatchFetch('https://example.com/schedule/pause')
    const replaceSchedule = (marker: string) =>
      worker.dispatchFetch('https://example.com/schedule', {
        method: 'POST',
        body: JSON.stringify({ cron: '0 0 * * *', timeZone: 'UTC', payload: { marker } }),
      })
    const first = replaceSchedule('first')
    await vi.waitFor(async () => {
      const state = await worker.dispatchFetch('https://example.com/schedule')
      expect(await state.json()).toMatchObject({ payload: { marker: 'first' } })
    })
    expect((await replaceSchedule('second')).status).toBe(200)
    await worker.dispatchFetch('https://example.com/schedule/release')
    expect((await first).status).toBe(200)
    const schedule = await worker.dispatchFetch('https://example.com/schedule')
    expect(await schedule.json()).toMatchObject({
      payload: { marker: 'second' },
      alarmId: expect.any(String),
    })
    await worker.dispose()
    worker = new Miniflare(convertV4MiniflareOptions(options))
    const response = await worker.dispatchFetch('https://example.com')
    expect(await response.json()).toMatchObject({ status: 'succeeded', output: 'Persisted result' })
    const persisted = await worker.dispatchFetch('https://example.com/schedule')
    expect(await persisted.json()).toMatchObject({ payload: { marker: 'second' } })
  } finally {
    await worker.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
