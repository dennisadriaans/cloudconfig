import { expect, it } from 'vitest'
import {
  resolveDatabaseProvider,
  type DatabaseProvider,
  type DeploymentTarget,
} from '../src/index.js'
import { databaseEnvNames, validateDataServices } from '../src/shared/data-env.js'

it.each([
  [undefined, 'd1'],
  ['cloudflare', 'd1'],
  ['vercel', 'turso'],
  ['azure', 'd1'],
] satisfies [DeploymentTarget | undefined, DatabaseProvider][])(
  'defaults %s hosting to %s',
  (target, provider) => {
    expect(resolveDatabaseProvider({ models: {}, deploy: target ? { target } : {} })).toBe(provider)
  },
)

it.each(['d1', 'turso', 'libsql'] as const)(
  'keeps an explicit %s provider on every host',
  (provider) => {
    for (const target of ['cloudflare', 'vercel', 'azure'] as const) {
      expect(
        resolveDatabaseProvider({ models: {}, db: { remote: { provider } }, deploy: { target } }),
      ).toBe(provider)
    }
  },
)

it('preserves generic libSQL credential names and supports Turso overrides', () => {
  expect(databaseEnvNames({ models: {}, db: { remote: { provider: 'libsql' } } })).toEqual({
    url: 'CLOUDCONFIG_DATABASE_URL',
    token: 'CLOUDCONFIG_DATABASE_TOKEN',
  })
  expect(databaseEnvNames({ models: {}, deploy: { target: 'vercel' } })).toEqual({
    url: 'TURSO_DATABASE_URL',
    token: 'TURSO_AUTH_TOKEN',
  })
  expect(
    databaseEnvNames({
      models: {},
      db: { remote: { provider: 'turso', urlEnv: 'CUSTOM_URL', tokenEnv: 'CUSTOM_TOKEN' } },
    }),
  ).toEqual({ url: 'CUSTOM_URL', token: 'CUSTOM_TOKEN' })
})

it.each(['neon', 'supabase', 'planetscale', 'postgresql', 'mysql', 'cosmos', 'truso'])(
  'rejects unsupported provider %s from JavaScript configs',
  (provider) => {
    const config = JSON.parse(JSON.stringify({ models: {}, db: { remote: { provider } } }))
    expect(() => validateDataServices(config)).toThrow(
      'PostgreSQL and MySQL engines are not supported yet',
    )
  },
)

it.each([{}, null])('rejects a remote database block without a provider: %j', (remote) => {
  const config = JSON.parse(JSON.stringify({ models: {}, db: { remote } }))
  expect(() => validateDataServices(config)).toThrow('Expected d1, turso or libsql')
})
