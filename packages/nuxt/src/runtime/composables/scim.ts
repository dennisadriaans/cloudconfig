/** SCIM directory provisioning for organization administrators, with SSR cookie forwarding. */
import { createScimClient, type ScimClient } from '@cloudconfig/core/client'
import { useRequestEvent, useRuntimeConfig } from '#imports'
import { toPath } from './cloudconfig.js'

export function useCloudConfigScim(): ScimClient {
  const config = useRuntimeConfig().public.cloudconfig as { authBasePath?: string } | undefined
  const event = useRequestEvent()
  return createScimClient({
    baseUrl: config?.authBasePath ?? '/api/auth',
    fetch: (input, init) => (event ? event.fetch(toPath(input), init) : fetch(input, init)),
  })
}
