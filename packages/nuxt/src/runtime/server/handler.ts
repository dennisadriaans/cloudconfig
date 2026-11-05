/**
 * The mounted backend. One handler for every CloudConfig route, with the database
 * resolved from the *request*: a Cloudflare binding when the platform supplies
 * one, a remote database on other production hosts, and local SQLite in
 * development. Every target uses the same config and request adapter.
 */
import { createBackend } from '@cloudconfig/core/server'
import type { DbProvider, GetUser } from '@cloudconfig/core/server'
import { configuredDatabase } from '@cloudconfig/core/drivers/configured'
import { resolveConfigExport } from '@cloudconfig/core'
import { defineEventHandler, useRuntimeConfig } from '#imports'
import * as configModule from '#cloudconfig/config'
import getUserModule from '#cloudconfig/user'
import { toRequest, type H3Event } from './request.js'

export { toRequest, type H3Event } from './request.js'

/** A config is valid whether it is exported as `config` or as the default. */
const config = resolveConfigExport(configModule, '#cloudconfig/config')

/** `#cloudconfig/user` is `null` until the app aliases it (see `server/cloudconfig/user.ts`). */
const getUser: GetUser | undefined =
  typeof getUserModule === 'function' ? (getUserModule as GetUser) : undefined

const databases = new Map<string, DbProvider>()
type Backend = ReturnType<typeof createBackend>
const backends = new WeakMap<DbProvider, Map<string, Backend>>()

/** Reuse connections while preserving runtime overrides of the config-derived defaults. */
export function databaseFor(event: H3Event): DbProvider {
  const settings = (useRuntimeConfig(event).cloudconfig ?? {}) as {
    d1Binding?: string
    localDb?: string
  }
  const binding = settings.d1Binding ?? config.db?.binding ?? 'DB'
  const local = settings.localDb ?? config.db?.local ?? '.cloudconfig/dev.db'
  const key = JSON.stringify([binding, local])
  let database = databases.get(key)
  if (!database) {
    database = configuredDatabase({ ...config, db: { ...config.db, binding, local } })
    databases.set(key, database)
  }
  return database
}

function backendFor(event: H3Event): Backend {
  const settings = (useRuntimeConfig(event).cloudconfig ?? {}) as { basePath?: string }
  const basePath = settings.basePath ?? config.server?.basePath ?? '/api'
  const database = databaseFor(event)
  let mounted = backends.get(database)
  if (!mounted) {
    mounted = new Map()
    backends.set(database, mounted)
  }
  let backend = mounted.get(basePath)
  if (!backend) {
    backend = createBackend(config, { basePath, db: database, ...(getUser ? { getUser } : {}) })
    mounted.set(basePath, backend)
  }
  return backend
}

export function platformEnv(event: H3Event): Record<string, unknown> | undefined {
  const cloudflare = Reflect.get(event.context, 'cloudflare')
  if (typeof cloudflare === 'object' && cloudflare !== null) {
    const env = Reflect.get(cloudflare, 'env')
    if (typeof env === 'object' && env !== null) return env as Record<string, unknown>
  }
  return undefined
}

export default defineEventHandler(async (event: H3Event) => {
  const env = platformEnv(event)

  const request = await toRequest(event)
  return backendFor(event).fetch(request, env)
})
