/**
 * `useCloudConfigConnectServer(event)` — act through connections from server
 * routes. The actor is the signed-in user with their active organization and
 * role, resolved the same way access rules see them.
 */
import { resolveConfigExport, type CloudConfigUser } from '@cloudconfig/core'
import { compileConfig, createAuthRuntime, type GetUser } from '@cloudconfig/core/server'
import {
  actorFromUser,
  createConnect,
  type Connect,
  type ConnectActor,
} from '@cloudconfig/core/connect'
import * as configModule from '#cloudconfig/config'
import getUserModule from '#cloudconfig/user'
import { databaseFor, platformEnv, toRequest, type H3Event } from './handler.js'

export interface CloudConfigConnectServer {
  connect: Connect
  /** The signed-in caller, or null. */
  actor(): Promise<ConnectActor | null>
}

export async function useCloudConfigConnectServer(
  event: H3Event,
): Promise<CloudConfigConnectServer> {
  const config = resolveConfigExport(configModule, '#cloudconfig/config')
  const base = compileConfig(config)
  const env = platformEnv(event)
  const provider = databaseFor(event)
  const request = await toRequest(event, true)
  const db = await provider.connect({ env, request })
  const custom = typeof getUserModule === 'function' ? (getUserModule as GetUser) : undefined
  const getUser =
    custom ?? (base.auth ? createAuthRuntime(base, base.auth, { db: provider }).getUser : undefined)
  let actor: Promise<ConnectActor | null> | undefined
  return {
    connect: createConnect(base, { db, env }),
    actor: () =>
      (actor ??= Promise.resolve(getUser ? getUser(request, { env }) : null).then((user) =>
        actorFromUser(user as CloudConfigUser | null),
      )),
  }
}
