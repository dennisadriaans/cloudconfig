import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { bundleWorker } from './helpers/worker-bundle.js'

it('continues native automation alarms, persists checkpoints and events, and routes scheduled runs to their owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudconfig-worker-automations-'))
  const script = await bundleWorker(`
import { createCloudflareAutomations } from './src/automations/cloudflare'
import { cloudflareAutomationPlatform } from './src/automations/cloudflare-client'
import { agentStub } from './src/agents/schedules'
import { automationDigest } from './src/automations/identity'
const scope = { ownerId: 1, workspace: 'personal' }
const Base = createCloudflareAutomations({
  async authorize() {},
  tasks: {
    async process(payload, context) {
      const first = await context.step('first', async () => crypto.randomUUID())
      await context.step('second', async () => payload)
      if (payload.wait) await context.waitForEvent('approved')
      return { first, done: true }
    },
  },
}, { binding: 'AUTOMATIONS' })
export class FixtureAutomations extends Base {
  async fireNow(key) {
    const row = this.sql\`SELECT key, value FROM cc_automation_records WHERE json_extract(value, '$.kind') = 'automation-schedule'\`[0]
    const value = JSON.parse(row.value)
    value.dueAt = new Date(Date.now() - 1000).toISOString()
    this.sql\`UPDATE cc_automation_records SET value = \${JSON.stringify(value)}, version = \${crypto.randomUUID()} WHERE key = \${row.key}\`
    await this.fireSchedule({ key, generation: value.generation, dueAt: value.dueAt })
    return 'scheduled_' + await automationDigest([key, value.generation, value.dueAt])
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const platform = cloudflareAutomationPlatform(env.AUTOMATIONS)
    const runs = await platform.runs(scope)
    if (url.pathname === '/schedule') {
      await platform.schedule('daily', { cron: '0 0 * * *', timeZone: 'UTC', run: { scope, task: 'process', payload: {} } })
      const stub = await agentStub(env.AUTOMATIONS, 'cloudconfig-automation-schedule-' + await automationDigest('daily'))
      return Response.json({ runId: await stub.fireNow('daily') })
    }
    const runId = url.searchParams.get('run') || 'persistent-run'
    if (url.pathname === '/signal') await runs.signal(runId, 'approved', true)
    else if (request.method === 'POST') return Response.json(await runs.start({ scope, runId, task: 'process', payload: { wait: true } }))
    return Response.json(await runs.status(runId))
  }
}`)
  const options = {
    name: 'cloudconfig-automation-fixture',
    modules: true,
    script,
    compatibilityDate: '2026-09-15',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { AUTOMATIONS: { className: 'FixtureAutomations', useSQLite: true } },
    resourcePersistencePath: directory,
    log: new Log(LogLevel.ERROR),
  }
  let worker = new Miniflare(convertV4MiniflareOptions(options))
  try {
    expect((await worker.dispatchFetch('https://example.com', { method: 'POST' })).status).toBe(200)
    const status = async (runId = 'persistent-run') => {
      const response = await worker.dispatchFetch(`https://example.com?run=${runId}`)
      return response.json()
    }
    await vi.waitFor(
      async () => {
        expect(await status()).toMatchObject({ status: 'waiting', waitingFor: 'approved' })
      },
      { timeout: 15000, interval: 100 },
    )
    await worker.dispose()
    worker = new Miniflare(convertV4MiniflareOptions(options))
    expect(await status()).toMatchObject({ status: 'waiting', waitingFor: 'approved' })
    await worker.dispatchFetch('https://example.com/signal')
    await vi.waitFor(
      async () => {
        expect(await status()).toMatchObject({
          status: 'succeeded',
          output: { first: expect.any(String), done: true },
        })
      },
      { timeout: 15000, interval: 100 },
    )
    const completed = await status()
    await worker.dispatchFetch('https://example.com', { method: 'POST' })
    expect(await status()).toEqual(completed)
    const response = await worker.dispatchFetch('https://example.com/schedule')
    const { runId } = (await response.json()) as { runId: string }
    await vi.waitFor(
      async () => {
        expect(await status(runId)).toMatchObject({ status: 'succeeded', output: { done: true } })
      },
      { timeout: 15000, interval: 100 },
    )
  } finally {
    await worker.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
}, 45000)
