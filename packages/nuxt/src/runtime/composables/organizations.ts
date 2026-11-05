import { createOrganizationClient } from '@cloudconfig/core/client'
import { useRequestEvent, useRuntimeConfig } from '#imports'
import { toPath } from './cloudconfig.js'

export function useCloudConfigOrganizations() {
  const config = useRuntimeConfig().public.cloudconfig as { authBasePath?: string } | undefined
  const event = useRequestEvent()
  return createOrganizationClient({
    baseUrl: config?.authBasePath ?? '/api/auth',
    fetch: (input, init) => (event ? event.fetch(toPath(input), init) : fetch(input, init)),
  })
}
