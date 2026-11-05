import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { databaseAgentRecords } from '../src/agents/database-records.js'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('persists agent records and rejects stale conditional writes after reconnecting', async () => {
  vi.stubEnv('NODE_ENV', 'test')
  const directory = mkdtempSync(join(tmpdir(), 'cloudconfig-agent-records-'))
  directories.push(directory)
  const config = { models: {}, db: { local: join(directory, 'agents.db') } }
  const first = databaseAgentRecords(config)
  expect(await first.create('run:1', 'accepted')).toBe(true)
  const original = await first.read('run:1')
  expect(original?.value).toBe('accepted')
  const second = databaseAgentRecords(config)
  expect(await second.create('run:1', 'duplicate')).toBe(false)
  expect(await second.replace('run:1', 'completed', original!.version)).toBe(true)
  expect(await first.replace('run:1', 'stale', original!.version)).toBe(false)
  expect(await first.read('run:1')).toMatchObject({ value: 'completed' })
})
