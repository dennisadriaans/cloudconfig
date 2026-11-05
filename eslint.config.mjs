import { createConfigForNuxt } from '@nuxt/eslint-config'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

export default createConfigForNuxt()
  .prepend({
    name: 'cloudconfig/ignores',
    ignores: [
      '**/.cloudconfig/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/.turbo/**',
      '**/.wrangler/**',
      '**/dist/**',
      '**/migrations/**',
      '**/node_modules/**',
      '**/worker-configuration.d.ts',
    ],
  })
  .append(
    {
      name: 'cloudconfig/project-conventions',
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-invalid-void-type': 'off',
        'import/no-mutable-exports': 'off',
        'no-nested-ternary': 'error',
        'one-var': ['error', 'never'],
        'no-control-regex': 'off',
        'no-useless-assignment': 'off',
        'vue/multi-word-component-names': 'off',
        'vue/no-v-html': 'off',
        'vue/require-default-prop': 'off',
      },
    },
    {
      name: 'cloudconfig/type-tests',
      files: ['**/*.test-d.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
    {
      name: 'cloudconfig/test-fixtures',
      files: ['**/test/**'],
      rules: {
        '@typescript-eslint/no-dynamic-delete': 'off',
      },
    },
    {
      name: 'cloudconfig/renderless-components',
      files: ['**/AgentSlot.vue', '**/SiteOgImage.vue'],
      rules: {
        'vue/valid-template-root': 'off',
      },
    },
    {
      // Declaration files pull in generated global types, which have no module to import.
      name: 'cloudconfig/declaration-references',
      files: ['**/*.d.ts'],
      rules: {
        '@typescript-eslint/triple-slash-reference': ['error', { path: 'always' }],
      },
    },
    eslintConfigPrettier,
    {
      // After eslint-config-prettier, which turns `curly` off; this option is Prettier-safe.
      name: 'cloudconfig/package-braces',
      files: ['packages/**'],
      rules: {
        curly: ['error', 'multi-line'],
      },
    },
  )
