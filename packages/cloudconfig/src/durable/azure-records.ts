import { BlobServiceClient, RestError } from '@azure/storage-blob'
import type { DurableRecordStore } from './records.js'

/** Azure Functions' storage account also persists run receipts, using ETags for conditional writes. */
export function azureExecutionRecords(connectionString: string): DurableRecordStore {
  const container =
    BlobServiceClient.fromConnectionString(connectionString).getContainerClient(
      'cloudconfig-agents',
    )
  let ready: ReturnType<typeof container.createIfNotExists> | undefined
  async function prepare() {
    const attempt = (ready ??= container.createIfNotExists())
    try {
      await attempt
    } catch (cause) {
      if (ready === attempt) ready = undefined
      throw cause
    }
  }
  const blob = (key: string) => container.getBlockBlobClient(encodeURIComponent(key))
  return {
    async read(key) {
      await prepare()
      try {
        const response = await blob(key).download()
        if (!response.etag) throw new Error('Azure Blob Storage did not return a record ETag.')
        const chunks: Buffer[] = []
        for await (const chunk of response.readableStreamBody!) chunks.push(Buffer.from(chunk))
        return { value: Buffer.concat(chunks).toString('utf8'), version: response.etag }
      } catch (error) {
        if (error instanceof RestError && error.statusCode === 404) return null
        throw error
      }
    },
    async create(key, value) {
      await prepare()
      try {
        await blob(key).uploadData(Buffer.from(value), { conditions: { ifNoneMatch: '*' } })
        return true
      } catch (error) {
        if (error instanceof RestError && [409, 412].includes(error.statusCode ?? 0)) return false
        throw error
      }
    },
    async replace(key, value, version) {
      await prepare()
      try {
        await blob(key).uploadData(Buffer.from(value), { conditions: { ifMatch: version } })
        return true
      } catch (error) {
        if (error instanceof RestError && [404, 412].includes(error.statusCode ?? 0)) return false
        throw error
      }
    },
  }
}
