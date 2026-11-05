import type { ModelStorage } from '../dsl/storage.js'

/** Byte-storage port. Metadata and authorization remain in the operations core. */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>
  get(key: string): Promise<ReadableStream<Uint8Array> | Uint8Array | null>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

/** Resolve byte storage per request and model without coupling the lifecycle to a platform. */
export type ObjectStoreProvider = (
  context: ObjectStoreContext,
  storage: ModelStorage,
) => ObjectStore | Promise<ObjectStore>

export interface ObjectStoreContext {
  request: Request
  env?: Record<string, unknown> | undefined
}
