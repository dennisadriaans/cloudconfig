/**
 * `useCloudConfig()` — the typed client, SSR-safe.
 *
 * On the server every call goes through the request event's fetch, so it is routed
 * inside Nitro (no HTTP round-trip back to the app) and carries the incoming
 * request's cookies — which is what makes an access rule see the same user
 * during SSR as it does on the client.
 */
import { createClient, type CloudConfigClient } from '@cloudconfig/core/client'
import type { AnyConfig } from '@cloudconfig/core'
import { useRequestEvent, useRuntimeConfig } from '#imports'

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/** Reduce any URL to a path Nitro can route internally. */
export function toPath(input: RequestInfo | URL): string {
  const raw = requestUrl(input)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw
  const url = new URL(raw)
  return `${url.pathname}${url.search}`
}

export function useCloudConfig<C extends AnyConfig>(): CloudConfigClient<C> {
  const basePath = String(
    (useRuntimeConfig().public.cloudconfig as { basePath?: string } | undefined)?.basePath ??
      '/api',
  )
  const event = useRequestEvent()
  // Nitro's event.fetch forwards the caller's cookies and returns a native
  // Response. event.$fetch is a wrapper and does not expose ofetch's .raw API.
  const fetchLike: typeof fetch = (input, init) =>
    event ? event.fetch(toPath(input), init) : fetch(input, init)

  const storagePaths = (
    useRuntimeConfig().public.cloudconfig as { storagePaths?: Record<string, string> } | undefined
  )?.storagePaths
  return createClient<C>({
    baseUrl: basePath,
    fetch: fetchLike,
    ...(storagePaths ? { storagePaths } : {}),
  })
}
