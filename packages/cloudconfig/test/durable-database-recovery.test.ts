import { expect, it, vi } from 'vitest'
import { databaseExecutionRecords } from '../src/durable/database-records.js'

const database = vi.hoisted(() => ({ run: vi.fn(), get: vi.fn(async () => null) }))
vi.mock('../src/drivers/configured.js', () => ({
  configuredDatabase: () => ({ connect: async () => database }),
}))

it('recovers record initialization after a transient database outage in a reused native step worker', async () => {
  database.run
    .mockRejectedValueOnce(new Error('Database temporarily unavailable'))
    .mockResolvedValue(undefined)
  const records = databaseExecutionRecords({ models: {} })
  await expect(records.read('job')).rejects.toThrow('Database temporarily unavailable')
  expect(await records.read('job')).toBeNull()
  expect(database.run).toHaveBeenCalledTimes(2)
  expect(await records.read('job')).toBeNull()
  expect(database.run).toHaveBeenCalledTimes(2)
})
