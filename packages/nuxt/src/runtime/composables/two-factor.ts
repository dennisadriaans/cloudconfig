import { createAuthClient } from 'better-auth/vue'
import { twoFactorClient } from 'better-auth/client/plugins'
import { passkeyClient } from '@better-auth/passkey/client'
import { useNuxtApp, useRuntimeConfig } from '#imports'

type ClientOptions = {
  basePath: string
  plugins: [ReturnType<typeof twoFactorClient>, ReturnType<typeof passkeyClient>]
}
type TwoFactorClient = ReturnType<typeof createAuthClient<ClientOptions>>

const clients = new WeakMap<object, TwoFactorClient>()

/** Email OTP enrollment and passkey ceremonies use the same mounted auth service. */
export function useCloudConfigTwoFactor(): TwoFactorClient {
  const app = useNuxtApp()
  let client = clients.get(app)
  if (!client) {
    const config = useRuntimeConfig().public.cloudconfig as { authBasePath?: string } | undefined
    client = createAuthClient<ClientOptions>({
      basePath: config?.authBasePath ?? '/api/auth',
      plugins: [twoFactorClient(), passkeyClient()],
    })
    clients.set(app, client)
  }
  return client
}
