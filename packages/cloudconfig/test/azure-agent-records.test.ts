import { Readable } from 'node:stream'
import { RestError } from '@azure/storage-blob'
import { beforeEach, expect, it, vi } from 'vitest'
import { azureAgentRecords } from '../src/agents/azure-records.js'

const { initialize, download, uploadData, getBlockBlobClient } = vi.hoisted(() => ({
  initialize: vi.fn(),
  download: vi.fn(),
  uploadData: vi.fn(),
  getBlockBlobClient: vi.fn(),
}))
vi.mock('@azure/storage-blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@azure/storage-blob')>()),
  BlobServiceClient: {
    fromConnectionString: () => ({
      getContainerClient: () => ({ createIfNotExists: initialize, getBlockBlobClient }),
    }),
  },
}))

beforeEach(() => {
  vi.resetAllMocks()
  initialize.mockResolvedValue({})
  download.mockImplementation(async () => ({
    etag: 'version-1',
    readableStreamBody: Readable.from(['accepted']),
  }))
  uploadData.mockResolvedValue({})
  getBlockBlobClient.mockReturnValue({ download, uploadData })
})

it('uses Blob ETags and conditional creation to fence concurrent record writes', async () => {
  const records = azureAgentRecords('fixture-connection')
  expect(initialize).not.toHaveBeenCalled()
  expect(await records.create('run:1', 'accepted')).toBe(true)
  expect(getBlockBlobClient).toHaveBeenCalledWith('run%3A1')
  expect(uploadData).toHaveBeenCalledWith(Buffer.from('accepted'), {
    conditions: { ifNoneMatch: '*' },
  })
  expect(await records.read('run:1')).toEqual({ value: 'accepted', version: 'version-1' })
  expect(await records.replace('run:1', 'completed', 'version-1')).toBe(true)
  expect(uploadData).toHaveBeenLastCalledWith(Buffer.from('completed'), {
    conditions: { ifMatch: 'version-1' },
  })
  uploadData.mockRejectedValueOnce(new RestError('Stale version', { statusCode: 412 }))
  expect(await records.replace('run:1', 'stale', 'version-1')).toBe(false)
  expect(initialize).toHaveBeenCalledOnce()
})

it('reports storage initialization failures to the activity and permits its native retry', async () => {
  initialize.mockRejectedValueOnce(new Error('Storage unavailable'))
  const records = azureAgentRecords('fixture-connection')
  await expect(records.create('run:1', 'accepted')).rejects.toThrow('Storage unavailable')
  expect(uploadData).not.toHaveBeenCalled()
  expect(await records.create('run:1', 'accepted')).toBe(true)
  expect(initialize).toHaveBeenCalledTimes(2)
  expect(uploadData).toHaveBeenCalledOnce()
})
