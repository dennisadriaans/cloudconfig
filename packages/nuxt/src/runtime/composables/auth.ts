/**
 * `useCloudConfigAuth()` — better-auth's Vue client, pointed at the path the module
 * actually mounted.
 *
 * Registered only when the CloudConfig config has an `auth` block, because importing
 * `better-auth/vue` in a project that never enabled auth would put a dependency
 * it does not have into the client bundle.
 */
import { createAuthClient } from 'better-auth/vue'
import { useNuxtApp, useRuntimeConfig } from '#imports'

type AuthClient = ReturnType<typeof createAuthClient>

const clients = new WeakMap<object, AuthClient>()

export function useCloudConfigAuth(): AuthClient {
  const app = useNuxtApp()
  let client = clients.get(app)
  if (!client) {
    const basePath = String(
      (useRuntimeConfig().public.cloudconfig as { authBasePath?: string } | undefined)
        ?.authBasePath ?? '/api/auth',
    )
    client = createAuthClient({ basePath })
    clients.set(app, client)
  }
  return client
}
