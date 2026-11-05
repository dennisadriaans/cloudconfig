/**
 * Nuxt's virtual modules. Typed loosely here so this package builds on its own;
 * inside a Nuxt app the real generated types win.
 */
declare module '#imports' {
  export { shallowRef, onScopeDispose, useAsyncData, defineNuxtPlugin } from 'nuxt/app'
  export const useNuxtApp: () => object
  export const useRequestEvent: () => { fetch: typeof fetch } | undefined
  export const defineEventHandler: <E, T>(handler: (event: E) => T) => unknown
  export const useRuntimeConfig: (event?: unknown) => {
    app: { baseURL: string }
    cloudconfig?: Record<string, unknown>
    public: Record<string, unknown>
  }
  export const useRequestFetch: () => {
    raw: (
      path: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ status: number; _data?: unknown }>
  }
}

declare module '#cloudconfig/config' {
  import type { AnyConfig } from '@cloudconfig/core'
  export const config: AnyConfig | undefined
  const fallback: AnyConfig | undefined
  export default fallback
}

declare module '#cloudconfig/user' {
  /** `null` until the app supplies `server/cloudconfig/user.ts`. */
  const getUser: ((request: Request) => unknown) | null
  export default getUser
}
