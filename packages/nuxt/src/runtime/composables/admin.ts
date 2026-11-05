import { createAdminClient } from '@cloudconfig/core/client'
import { useRequestEvent, useRuntimeConfig } from '#imports'
import { toPath } from './cloudconfig.js'

export function useCloudConfigAdmin() {
  const config = useRuntimeConfig().public.cloudconfig as { authBasePath?: string } | undefined
  const event = useRequestEvent()
  return createAdminClient({
    baseUrl: config?.authBasePath ?? '/api/auth',
    fetch: (input, init) => (event ? event.fetch(toPath(input), init) : fetch(input, init)),
  })
}
