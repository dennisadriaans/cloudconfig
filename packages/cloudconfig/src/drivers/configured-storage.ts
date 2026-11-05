import type { AnyConfig, ModelStorage } from '../index.js'
import type { ObjectStore, ObjectStoreContext } from '../server/object-store.js'
import { storageEnvNames, validateDataServices } from '../shared/data-env.js'
import { readEnv } from '../server/auth/env.js'

/** Platform bindings stay on the request; Node imports are reached only locally. */
export async function configuredObjectStore(
  config: AnyConfig,
  ctx: ObjectStoreContext,
  storage: ModelStorage,
): Promise<ObjectStore> {
  validateDataServices(config)
  if (
    readEnv('NODE_ENV', ctx.env) === 'production' &&
    (config.storage || readEnv(storageEnvNames(config).endpoint, ctx.env))
  ) {
    const names = storageEnvNames(config)
    const credentials = Object.fromEntries(
      Object.entries(names).map(([key, name]) => [key, readEnv(name, ctx.env)]),
    )
    for (const [key, name] of Object.entries(names)) {
      if (!credentials[key]) throw new Error(`Object storage requires ${name}.`)
    }
    const { s3Store } = await import('../drivers/s3.js')
    const store: ObjectStore = s3Store({
      endpoint: credentials['endpoint']!,
      bucket: credentials['bucket']!,
      accessKeyId: credentials['accessKeyId']!,
      secretAccessKey: credentials['secretAccessKey']!,
      ...(config.storage?.region ? { region: config.storage.region } : {}),
    })
    return store
  }
  const binding = storage.binding ?? config.deploy?.r2Binding ?? 'STORAGE'
  const bucket = ctx.env?.[binding]
  if (bucket) {
    // A structural port keeps the core usable without a Cloudflare type dependency.
    const r2 = bucket as {
      put(
        key: string,
        bytes: Uint8Array,
        options: { httpMetadata: { contentType: string } },
      ): Promise<unknown>
      get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>
      delete(key: string): Promise<void>
      list(options: {
        prefix: string
        cursor?: string
      }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>
    }
    return {
      put: async (key, bytes, mimeType) => {
        await r2.put(key, bytes, { httpMetadata: { contentType: mimeType } })
      },
      get: async (key) => (await r2.get(key))?.body ?? null,
      delete: (key) => r2.delete(key),
      async list(prefix) {
        const keys: string[] = []
        let cursor: string | undefined
        do {
          const page = await r2.list({ prefix, ...(cursor ? { cursor } : {}) })
          keys.push(...page.objects.map((object) => object.key))
          cursor = page.truncated ? page.cursor : undefined
        } while (cursor)
        return keys
      },
    }
  }
  if (ctx.env?.[config.db?.binding ?? 'DB'] || readEnv('NODE_ENV', ctx.env) === 'production') {
    throw new Error(`Storage is not configured. Add the ${binding} R2 binding.`)
  }
  const [
    { mkdir, writeFile, unlink, readdir },
    { resolve, dirname, join },
    { createReadStream },
    { Readable },
  ] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
    import('node:fs'),
    import('node:stream'),
  ])
  const root = resolve(storage.local ?? '.cloudconfig/uploads')
  function path(key: string) {
    if (
      !key ||
      key.split('/').some((part) => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')
    ) {
      throw new Error('Invalid storage key.')
    }
    return join(root, key)
  }
  return {
    async put(key, bytes) {
      const target = path(key)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    },
    async get(key) {
      try {
        // Check existence before constructing a stream so missing bytes return 404.
        const { stat } = await import('node:fs/promises')
        await stat(path(key))
        return Readable.toWeb(createReadStream(path(key))) as ReadableStream<Uint8Array>
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw cause
      }
    },
    async delete(key) {
      try {
        await unlink(path(key))
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
    },
    async list(prefix) {
      const directory = path(prefix.replace(/\/$/, ''))
      try {
        return (await readdir(directory)).map((name) => `${prefix}${name}`)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw cause
      }
    },
  }
}
