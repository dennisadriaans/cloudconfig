import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/module.ts',
    'src/runtime/server/handler.ts',
    'src/runtime/server/client.ts',
    'src/runtime/server/anonymous.ts',
    'src/runtime/server/agents.ts',
    'src/runtime/server/automations.ts',
    'src/runtime/server/automation-configure.ts',
    'src/runtime/server/connect.ts',
    'src/runtime/composables/cloudconfig.ts',
    'src/runtime/composables/auth.ts',
    'src/runtime/composables/two-factor.ts',
    'src/runtime/composables/admin.ts',
    'src/runtime/composables/account.ts',
    'src/runtime/composables/organizations.ts',
    'src/runtime/composables/connect.ts',
    'src/runtime/composables/scim.ts',
    'src/runtime/composables/table.ts',
    'src/runtime/plugins/studio.client.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'neutral',
  // Keep core imports external even when tsconfig paths resolve to workspace source.
  // Declarations must reference the installed core types instead of copying them.
  external: [
    /^@cloudconfig\/core(?:\/|$)/,
    /^node:/,
    '#imports',
    '#cloudconfig/config',
    '#cloudconfig/user',
  ],
})
