/**
 * `useCloudConfigConnect()` — manage connections and start the flows that add
 * them. Tokens never reach the browser; server code reads them through
 * `useCloudConfigConnectServer(event)`.
 */
import { createConnectClient, type ConnectClient } from '@cloudconfig/core/client'
import { useRequestEvent, useRuntimeConfig } from '#imports'
import { toPath } from './cloudconfig.js'

export function useCloudConfigConnect(): ConnectClient {
  const config = useRuntimeConfig().public.cloudconfig as { connectBasePath?: string } | undefined
  const event = useRequestEvent()
  return createConnectClient({
    baseUrl: config?.connectBasePath ?? '/api/connect',
    fetch: (input, init) => (event ? event.fetch(toPath(input), init) : fetch(input, init)),
  })
}
