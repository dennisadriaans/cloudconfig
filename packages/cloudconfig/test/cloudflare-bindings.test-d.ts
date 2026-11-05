import { it } from 'vitest'
import { bindings, defineConfig } from 'cf/config'
import { defineBackend, model, t } from '../src/index.js'
import { cloudflareBindings } from '../src/cloudflare.js'

// The helper's structural binding types must stay assignable to cf's own.
it('spreads into a cf Worker env', () => {
  const config = defineBackend({
    models: { note: model({ title: t.text() }) },
    db: { name: 'notes-db' },
    deploy: { r2: 'notes-files', secrets: ['API_KEY'] },
  })
  defineConfig({
    worker: {
      name: 'notes',
      compatibilityDate: '2026-10-14',
      entrypoint: './src/index.ts',
      env: { ...cloudflareBindings(config), ASSETS: bindings.assets() },
    },
  })
})
