import { defineNuxtPlugin, useRuntimeConfig } from '#imports'
import { mountStudioToolbar } from '@cloudconfig/core/devtools/client'

// This plugin is registered only in dev mode, never in a production build.
export default defineNuxtPlugin((nuxtApp) => {
  const base = useRuntimeConfig().app.baseURL.replace(/\/$/, '')
  nuxtApp.hook('app:mounted', () => {
    const dispose = mountStudioToolbar(`${base}/_cloudconfig/studio`)
    nuxtApp.vueApp.onUnmount?.(dispose)
  })
})
