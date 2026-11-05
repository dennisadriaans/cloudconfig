import { ConfigError } from '../shared/errors.js'
import type { CompiledModel } from './compile/index.js'
import type { Operations, OpResult, RequestContext } from './operations.js'
import type { ObjectStoreProvider, ObjectStore } from './object-store.js'

export interface StorageMapping {
  name: string
  mimeType: string
  size: string
  key: string
  owner: string
  text?: string
}
export interface StorageDownload {
  body: ReadableStream<Uint8Array> | Uint8Array
  name: string
  mimeType: string
  size: number
}
export interface UploadInput {
  file: File
  fields?: Record<string, unknown>
}
interface Cleanup {
  key: string
  owner: number
}
export function storageMapping(model: Pick<CompiledModel, 'model'>): StorageMapping {
  const fields = model.model.options.storage?.fields
  return {
    name: fields?.name ?? 'name',
    mimeType: fields?.mimeType ?? 'mimeType',
    size: fields?.size ?? 'size',
    key: fields?.key ?? 'storageKey',
    owner: fields?.owner ?? 'ownerId',
    ...(fields?.text ? { text: fields.text } : {}),
  }
}
export function storagePath(model: CompiledModel): string {
  return model.model.options.storage?.path ?? `/${model.namePlural}/content`
}
export function validateStorage(model: CompiledModel): void {
  const storage = model.model.options.storage
  if (!storage) return
  const mapping = storageMapping(model)
  for (const field of Object.values(mapping)) {
    if (!model.fieldSpecs[field]) {
      throw new ConfigError(`model "${model.name}": storage field "${field}" does not exist.`)
    }
  }
  for (const field of [mapping.key, mapping.owner, ...(mapping.text ? [mapping.text] : [])]) {
    if (!model.fieldSpecs[field]?.spec.serverOnly) {
      throw new ConfigError(
        `model "${model.name}": storage field "${field}" must use .serverOnly().`,
      )
    }
  }
  if (
    model.fieldSpecs[mapping.key]?.spec.kind !== 'text' ||
    !model.fieldSpecs[mapping.key]?.spec.unique ||
    !model.fieldSpecs[mapping.key]?.spec.required
  ) {
    throw new ConfigError(`model "${model.name}": the storage key must be required, unique text.`)
  }
  if (
    model.fieldSpecs[mapping.owner]?.spec.kind !== 'number' ||
    !model.fieldSpecs[mapping.owner]?.spec.required
  ) {
    throw new ConfigError(`model "${model.name}": the storage owner must be a required number.`)
  }
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(storagePath(model))) {
    throw new ConfigError(`model "${model.name}": use a static storage path starting with /.`)
  }
  if (
    storage.maxSize !== undefined &&
    (!Number.isSafeInteger(storage.maxSize) || storage.maxSize < 1)
  ) {
    throw new ConfigError(`model "${model.name}": storage.maxSize must be a positive byte count.`)
  }
}

/** Database lookups and access checks the storage lifecycle delegates to operations. */
export interface StorageLifecycleHooks {
  storeFor: ObjectStoreProvider
  userFor: (ctx: RequestContext) => Promise<unknown>
  findKey: (
    ctx: RequestContext,
    model: CompiledModel,
    key: string,
  ) => Promise<Record<string, unknown> | undefined>
  authorizeUpload: (
    ctx: RequestContext,
    model: CompiledModel,
    input: Record<string, unknown>,
  ) => Promise<OpResult<null>>
  deletionRow: (
    ctx: RequestContext,
    model: CompiledModel,
    id: unknown,
  ) => Promise<OpResult<Record<string, unknown>>>
}

interface PendingCleanup {
  marker: string
  record: Cleanup
}

export function createStorageLifecycle(
  raw: Operations,
  { userFor, findKey, authorizeUpload, deletionRow, storeFor }: StorageLifecycleHooks,
) {
  const failure = <T>(message: string): OpResult<T> => ({
    ok: false,
    code: 'storage_failed',
    issues: [{ path: 'file', message }],
  })
  async function userId(ctx: RequestContext) {
    const user = (await userFor(ctx)) as { id?: unknown } | null
    const id = Number(user?.id)
    return Number.isSafeInteger(id) && id > 0 ? id : null
  }
  const validKey = (key: string, owner: number) =>
    key.startsWith(`${owner}/`) && /^\d+\/[a-f0-9-]{36}$/.test(key)
  const prefix = (model: CompiledModel, owner: number) => `_cleanup/${model.name}/${owner}/`
  async function cleanup(
    ctx: RequestContext,
    model: CompiledModel,
    store: ObjectStore,
    { marker, record }: PendingCleanup,
  ) {
    // Never remove bytes while metadata still points at them, including hook failures.
    if (!validKey(record.key, record.owner)) throw new Error('Invalid cleanup key.')
    if (await findKey(ctx, model, record.key)) return false
    await store.delete(record.key)
    await store.delete(marker)
    return true
  }
  async function queueCleanup(
    model: CompiledModel,
    store: ObjectStore,
    { key, owner }: Cleanup,
    id: string,
  ): Promise<PendingCleanup> {
    const marker = `${prefix(model, owner)}${id}.json`
    const record = { key, owner }
    await store.put(marker, new TextEncoder().encode(JSON.stringify(record)), 'application/json')
    return { marker, record }
  }
  async function readMarker(store: ObjectStore, key: string): Promise<Cleanup | null> {
    const body = await store.get(key)
    if (!body) return null
    return JSON.parse(await new Response(body as BodyInit).text()) as Cleanup
  }
  return {
    async upload(
      ctx: RequestContext,
      model: CompiledModel,
      input: unknown,
    ): Promise<OpResult<Record<string, unknown>>> {
      const owner = await userId(ctx)
      if (owner === null) return { ok: false, code: 'forbidden' }
      const value = input as Partial<UploadInput> | null
      if (!(value?.file instanceof File) || !value.file.name.trim()) {
        return {
          ok: false,
          code: 'validation',
          issues: [{ path: 'file', message: 'Choose a file to upload.' }],
        }
      }
      const file = value.file
      const storage = model.model.options.storage!
      if (file.size > (storage.maxSize ?? 25 * 1024 * 1024)) {
        return {
          ok: false,
          code: 'payload_too_large',
          issues: [
            {
              path: 'file',
              message: `Files must be ${storage.maxSize ?? 25 * 1024 * 1024} bytes or smaller.`,
            },
          ],
        }
      }
      const mimeType = file.type || 'application/octet-stream'
      if (storage.mimeTypes && !storage.mimeTypes.includes(mimeType)) {
        return {
          ok: false,
          code: 'unsupported_media_type',
          issues: [{ path: 'file', message: 'This file type is not allowed.' }],
        }
      }
      const fields = storageMapping(model)
      const supplied = value.fields ?? {}
      if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
        return {
          ok: false,
          code: 'validation',
          issues: [{ path: 'fields', message: 'File metadata must be an object.' }],
        }
      }
      const managed = [
        fields.name,
        fields.mimeType,
        fields.size,
        fields.key,
        fields.owner,
        ...(fields.text ? [fields.text] : []),
      ]
      const invalid = Object.keys(supplied).filter(
        (key) => managed.includes(key) || model.fieldSpecs[key]?.spec.serverOnly,
      )
      if (invalid.length) {
        return {
          ok: false,
          code: 'validation',
          issues: invalid.map((path) => ({ path, message: 'This field is managed by storage.' })),
        }
      }
      const key = `${owner}/${crypto.randomUUID()}`
      let text = ''
      if (storage.extractText) text = await storage.extractText(file)
      const metadata = {
        ...supplied,
        [fields.name]: file.name.trim().slice(0, 255),
        [fields.mimeType]: mimeType,
        [fields.size]: file.size,
        [fields.key]: key,
        [fields.owner]: owner,
        ...(fields.text ? { [fields.text]: text } : {}),
      }
      const permission = await authorizeUpload(ctx, model, metadata)
      if (!permission.ok) return permission
      const store = await storeFor(ctx, storage)
      let result: OpResult<Record<string, unknown>>
      try {
        await store.put(key, new Uint8Array(await file.arrayBuffer()), mimeType)
        result = await raw.create(ctx, model.namePlural, metadata)
      } catch (cause) {
        console.error('[cloudconfig:storage] metadata save failed', cause)
        // afterChange can fail after the insert; return the committed record.
        try {
          const saved = await findKey(ctx, model, key)
          if (saved) return { ok: true, value: saved }
        } catch {
          /* The durable marker below waits for database recovery. */
        }
        result = failure('Could not save file metadata. Try again.')
      }
      if (!result.ok) {
        try {
          const pending = await queueCleanup(model, store, { key, owner }, key.split('/')[1]!)
          await cleanup(ctx, model, store, pending)
        } catch (cause) {
          console.error('[cloudconfig:storage] upload cleanup pending', {
            model: model.name,
            key,
            owner,
            cause,
          })
        }
      }
      return result
    },
    async download(
      ctx: RequestContext,
      model: CompiledModel,
      id: unknown,
    ): Promise<OpResult<StorageDownload>> {
      const row = await raw.get(ctx, model.namePlural, id)
      if (!row.ok) return row
      const fields = storageMapping(model)
      const store = await storeFor(ctx, model.model.options.storage!)
      const key = String(row.value[fields.key])
      if (!validKey(key, Number(row.value[fields.owner]))) return { ok: false, code: 'not_found' }
      const body = await store.get(key)
      if (!body) return { ok: false, code: 'not_found' }
      return {
        ok: true,
        value: {
          body,
          name: String(row.value[fields.name]),
          mimeType: String(row.value[fields.mimeType]),
          size: Number(row.value[fields.size]),
        },
      }
    },
    async remove(ctx: RequestContext, model: CompiledModel, id: unknown): Promise<OpResult<null>> {
      const owner = await userId(ctx)
      if (owner === null) return { ok: false, code: 'not_found' }
      const store = await storeFor(ctx, model.model.options.storage!)
      const row = await deletionRow(ctx, model, id)
      if (!row.ok) {
        if (row.code !== 'not_found' || !Number.isSafeInteger(Number(id))) return row
        const marker = `${prefix(model, owner)}${Number(id)}.json`
        const record = await readMarker(store, marker)
        if (!record || record.owner !== owner) return row
        try {
          await cleanup(ctx, model, store, { marker, record })
          return { ok: true, value: null }
        } catch (cause) {
          console.error('[cloudconfig:storage] delete cleanup pending', { marker, cause })
          return failure('File cleanup failed. Retry deleting the file.')
        }
      }
      const fields = storageMapping(model)
      if (!validKey(String(row.value[fields.key]), Number(row.value[fields.owner]))) {
        return { ok: false, code: 'not_found' }
      }
      const pending = await queueCleanup(
        model,
        store,
        { key: String(row.value[fields.key]), owner: Number(row.value[fields.owner]) },
        String(row.value['id']),
      )
      let result: OpResult<null>
      try {
        result = await raw.remove(ctx, model.namePlural, id)
      } catch (cause) {
        if (await findKey(ctx, model, pending.record.key)) throw cause
        console.error('[cloudconfig:storage] delete hook failed after commit', cause)
        result = { ok: true, value: null }
      }
      if (!result.ok) {
        await store.delete(pending.marker)
        return result
      }
      try {
        await cleanup(ctx, model, store, pending)
      } catch (cause) {
        console.error('[cloudconfig:storage] delete cleanup pending', {
          marker: pending.marker,
          cause,
        })
      }
      return result
    },
    async retryCleanup(
      ctx: RequestContext,
      model: CompiledModel,
    ): Promise<OpResult<{ cleaned: number }>> {
      const owner = await userId(ctx)
      if (owner === null) return { ok: false, code: 'forbidden' }
      const store = await storeFor(ctx, model.model.options.storage!)
      let cleaned = 0
      for (const marker of await store.list(prefix(model, owner))) {
        const record = await readMarker(store, marker)
        if (
          record &&
          record.owner === owner &&
          (await cleanup(ctx, model, store, { marker, record }))
        ) {
          cleaned++
        }
      }
      return { ok: true, value: { cleaned } }
    },
  }
}
