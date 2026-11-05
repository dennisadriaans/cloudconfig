import { createServerClient, type ServerClient, type GetUser } from '@cloudconfig/core/server'
import { resolveConfigExport, type AnyConfig } from '@cloudconfig/core'
import * as configModule from '#cloudconfig/config'
import getUserModule from '#cloudconfig/user'
import { databaseFor, platformEnv, toRequest, type H3Event } from './handler.js'

/** Private fields are available here; request identity and access rules remain enforced. */
export async function useCloudConfigServer<C extends AnyConfig>(
  event: H3Event,
): Promise<ServerClient<C>> {
  const config = resolveConfigExport(configModule, '#cloudconfig/config') as C
  const env = platformEnv(event)
  const db = databaseFor(event)
  const getUser = typeof getUserModule === 'function' ? (getUserModule as GetUser) : undefined
  return createServerClient(
    config,
    { request: await toRequest(event, true), ...(env ? { env } : {}) },
    { db, ...(getUser ? { getUser } : {}) },
  )
}
