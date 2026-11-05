import { describe, expect, it, vi } from 'vitest'
import { defineBackend, model, t, type ModelOptions } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { createServerClient } from '../src/server/client.js'
import { createOperations, type RequestContext } from '../src/server/operations.js'
import { buildOpenApiDocument } from '../src/server/openapi.js'
import { buildToolDefs, runTool } from '../src/server/tool-defs.js'
import { memoryProvider } from './memory-provider.js'

function setup(options: ModelOptions = {}) {
  const config = defineBackend({
    models: {
      file: model(
        {
          name: t.text().required(),
          folder: t.text().required(),
          mimeType: t.text().required(),
          size: t.number().required(),
          storageKey: t.text().required().unique().serverOnly(),
          ownerId: t.number().required().serverOnly(),
          searchableText: t.textarea().serverOnly(),
        },
        {
          access: {
            list: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
            read: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
            create: ({ user }) => !!user,
            delete: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
          },
          storage: {
            binding: 'FILES',
            maxSize: 100,
            fields: { text: 'searchableText' },
            extractText: (file) => file.text(),
          },
          ...options,
        },
      ),
    },
  })
  const data = memoryProvider(config)
  const objects = new Map<string, Uint8Array>()
  const bucket = {
    put: vi.fn(async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes)
    }),
    get: vi.fn(async (key: string) =>
      objects.has(key) ? { body: new Response(new Uint8Array(objects.get(key)!)).body! } : null,
    ),
    delete: vi.fn(async (key: string) => {
      objects.delete(key)
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
      truncated: false,
    })),
  }
  const ctx: RequestContext = {
    request: new Request('http://internal/'),
    user: { id: 1 },
    env: { FILES: bucket },
  }
  const ops = createOperations(config, { data })
  const upload = () =>
    ops.upload(ctx, 'files', {
      file: new File(['budget'], 'notes.txt', { type: 'text/plain' }),
      fields: { folder: 'Work' },
    })
  return { config, data, objects, bucket, ctx, ops, upload }
}

describe('trusted storage', () => {
  it('swaps byte-storage adapters while retaining upload authorization and metadata', async () => {
    const { config, data, ctx, bucket } = setup()
    const bytes = new Map<string, Uint8Array>()
    const ops = createOperations(config, {
      data,
      storage: () => ({
        put: async (key, content) => {
          bytes.set(key, content)
        },
        get: async (key) => bytes.get(key) ?? null,
        delete: async (key) => {
          bytes.delete(key)
        },
        list: async (prefix) => [...bytes.keys()].filter((key) => key.startsWith(prefix)),
      }),
    })
    const production = { ...ctx, env: { NODE_ENV: 'production' } }
    const result = await ops.upload(production, 'files', {
      file: new File(['portable'], 'notes.txt'),
      fields: { folder: 'Work' },
    })
    expect(result).toMatchObject({ ok: true, value: { name: 'notes.txt', size: 8 } })
    expect(bytes.size).toBe(1)
    expect(bucket.put).not.toHaveBeenCalled()
    expect(await ops.download({ ...production, user: { id: 2 } }, 'files', 1)).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(await ops.download(production, 'files', 1)).toMatchObject({
      ok: true,
      value: { name: 'notes.txt', size: 8 },
    })
  })

  it('assigns ownership and keys, projects public rows, and preserves rules for server calls', async () => {
    const { config, data, objects, ctx, ops, upload } = setup()
    const result = await upload()
    expect(result).toMatchObject({ ok: true, value: { name: 'notes.txt', size: 6 } })
    if (!result.ok) throw new Error('Upload failed')
    expect(result.value).not.toHaveProperty('storageKey')
    expect(result.value).not.toHaveProperty('searchableText')
    expect(result.value).not.toHaveProperty('ownerId')
    const server = createServerClient(config, ctx, { data })
    const row = await server.file.get(1)
    expect(row.storageKey).toMatch(/^1\//)
    expect(row.searchableText).toBe('budget')
    expect(objects.has(row.storageKey)).toBe(true)
    const other = createServerClient(config, { ...ctx, user: { id: 2 } }, { data })
    await expect(other.file.get(1)).rejects.toMatchObject({ status: 404 })
    expect(await ops.download({ ...ctx, user: { id: 2 } }, 'files', 1)).toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })

  it('rejects forged metadata, private queries, oversized files, and denied uploads before writing bytes', async () => {
    const { ctx, ops, bucket } = setup()
    const file = new File(['x'], 'notes.txt')
    expect(
      await ops.create(ctx, 'files', { name: 'Forged', storageKey: '2/key', ownerId: 1 }),
    ).toMatchObject({ ok: false, code: 'validation' })
    expect(
      await ops.upload(ctx, 'files', { file, fields: { folder: 'Work', storageKey: '2/key' } }),
    ).toMatchObject({ ok: false, code: 'validation' })
    expect(
      await ops.upload(ctx, 'files', { file: new File(['x'.repeat(101)], 'large.txt') }),
    ).toMatchObject({ ok: false, code: 'payload_too_large' })
    expect(await ops.upload({ ...ctx, user: null }, 'files', { file })).toMatchObject({
      ok: false,
      code: 'forbidden',
    })
    expect(
      await ops.list(ctx, 'files', { page: 1, pageSize: 20, sortDir: 'asc', sortBy: 'storageKey' }),
    ).toMatchObject({ ok: false, code: 'validation' })
    expect(bucket.put).not.toHaveBeenCalled()
    const denied = setup({ access: { create: () => false } })
    expect(await denied.upload()).toMatchObject({ ok: false, code: 'forbidden' })
    expect(denied.bucket.put).not.toHaveBeenCalled()
  })

  it('rolls back bytes when model validation fails after upload preparation', async () => {
    const { data, objects, upload } = setup({
      validate: () => [{ path: 'folder', message: 'Choose another folder.' }],
    })
    expect(await upload()).toMatchObject({ ok: false, code: 'validation' })
    expect(data.rows('file')).toHaveLength(0)
    expect(objects.size).toBe(0)
  })

  it('retains committed bytes when an after-change hook fails', async () => {
    const { data, objects, upload } = setup({
      hooks: {
        afterChange: () => {
          throw new Error('Notification failed')
        },
      },
    })
    expect(await upload()).toMatchObject({ ok: true })
    expect(data.rows('file')).toHaveLength(1)
    expect(objects.has(String(data.rows('file')[0]!['storageKey']))).toBe(true)
  })

  it('cleans bytes through generic deletion and persists failed cleanup for retry', async () => {
    const { config, data, objects, bucket, ctx, ops, upload } = setup()
    await upload()
    const key = String(data.rows('file')[0]!['storageKey'])
    bucket.delete.mockImplementationOnce(async () => {
      throw new Error('R2 unavailable')
    })
    expect(await ops.remove(ctx, 'files', 1)).toMatchObject({ ok: true })
    expect(data.rows('file')).toHaveLength(0)
    expect(objects.has(key)).toBe(true)
    expect([...objects.keys()].some((key) => key.startsWith('_cleanup/file/1/'))).toBe(true)
    const server = createServerClient(config, ctx, { data })
    expect(await server.file.retryCleanup()).toEqual({ cleaned: 1 })
    expect(objects.size).toBe(0)
  })

  it('uses delete access independently of read access', async () => {
    const { ctx, ops, objects, upload } = setup({
      access: { create: () => true, read: () => false, delete: () => true },
    })
    await upload()
    expect(await ops.remove(ctx, 'files', 1)).toMatchObject({ ok: true })
    expect(objects.size).toBe(0)
  })

  it('generates multipart REST docs and lifecycle agent tools', async () => {
    const { config, data, ctx, ops, bucket } = setup()
    const tools = buildToolDefs(ops.base)
    expect(tools.some((tool) => tool.name === 'files_create')).toBe(false)
    const upload = tools.find((tool) => tool.name === 'files_upload')!
    expect(
      await runTool(ops, ctx, upload, {
        name: 'notes.txt',
        content: btoa('notes'),
        fields: { folder: 'Work' },
      }),
    ).toMatchObject({ ok: true })
    const doc = buildOpenApiDocument(ops.base)
    expect(doc.paths['/files']!.post!.requestBody!.content).toHaveProperty('multipart/form-data')
    const app = createBackend(config, { data, getUser: () => ({ id: 1 }) })
    const response = await app.fetch(new Request('http://localhost/api/files/1'), { FILES: bucket })
    const row = await response.json()
    expect(row).not.toHaveProperty('storageKey')
    const download = await app.fetch(new Request('http://localhost/api/files/content/1'), {
      FILES: bucket,
    })
    expect(await download.text()).toBe('notes')
    expect(download.headers.get('cache-control')).toBe('private, no-store')
  })
})

describe('private relation projections', () => {
  it('omits server-only target fields from nested public rows', async () => {
    const config = defineBackend({
      access: { default: 'allow' },
      models: {
        person: model({ name: t.text().required(), email: t.email().serverOnly() }),
        note: model({ author: t.relation('person'), title: t.text().required() }),
      },
    })
    const data = memoryProvider(config)
    const ctx = { request: new Request('http://internal/') }
    const server = createServerClient(config, ctx, { data })
    await server.person.create({ name: 'Ada', email: 'private@example.com' })
    await server.note.create({ title: 'Notes', authorId: 1 })
    const ops = createOperations(config, { data })
    expect(await ops.get(ctx, 'notes', 1)).toMatchObject({
      ok: true,
      value: { author: { id: 1, name: 'Ada' } },
    })
    const result = await ops.get(ctx, 'notes', 1)
    if (!result.ok) throw new Error('Read failed')
    expect(result.value['author']).not.toHaveProperty('email')
    expect(
      await ops.create(ctx, 'persons', { name: 'Leak', email: 'private@example.com' }),
    ).toMatchObject({ ok: false, code: 'validation' })
  })
})
