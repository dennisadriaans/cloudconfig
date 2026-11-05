import { expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import {
  accountIdFrom,
  addCustomDomainRoute,
  addD1Binding,
  isValidCustomDomain,
  readCustomDomains,
  readD1Binding,
  setDatabaseId,
  workerNameFrom,
} from '../src/cli/cloudflare/wrangler-config.js'

it('reads only active top-level deployment settings', () => {
  const text = `{
    // "name": "wrong", "d1_databases": [{ "binding": "BAD" }]
    "env": { "staging": { "name": "staging", "d1_databases": [{ "binding": "STAGING", "database_id": "staging-id" }] } },
    "name": "production", "account_id": "account",
    "d1_databases": [{ "binding": "DB", "database_name": "production-db", "database_id": "" }],
  }`
  expect(workerNameFrom(text, 'fallback')).toBe('production')
  expect(accountIdFrom(text)).toBe('account')
  expect(readD1Binding(text)).toEqual({
    binding: 'DB',
    databaseName: 'production-db',
    databaseId: '',
  })
  const patched = parse(setDatabaseId(text, 'production-id'))
  expect(patched.d1_databases[0].database_id).toBe('production-id')
  expect(patched.env.staging.d1_databases[0].database_id).toBe('staging-id')
})

it('adds a binding when a config has an empty array or a comment containing braces', () => {
  const result = addD1Binding('// sample { ignored }\n{"name":"worker","d1_databases":[]}', {
    binding: 'DB',
    databaseName: 'db',
    databaseId: 'id',
    migrationsDir: 'migrations',
  })
  expect(parse(result).d1_databases).toEqual([
    { binding: 'DB', database_name: 'db', database_id: 'id', migrations_dir: 'migrations' },
  ])
})

it('reads TOML single-quoted top-level settings without selecting an environment', () => {
  const text =
    "name = 'production'\n[env.staging]\nname = 'staging'\n[[env.staging.d1_databases]]\nbinding = 'STAGING'\n"
  expect(workerNameFrom(text, 'fallback')).toBe('production')
  expect(readD1Binding(text)).toBeUndefined()
})

it('refuses ambiguous multiple bindings before provisioning', () => {
  expect(() => readD1Binding('{"d1_databases":[{"binding":"A"},{"binding":"B"}]}')).toThrow(
    'Multiple bindings',
  )
})

// Custom domains (deploy.domain)

it('accepts hostnames and rejects what Cloudflare would reject', () => {
  for (const host of [
    'api.example.com',
    'example.com',
    'a.b.c.example.co.uk',
    'my-api.example.com',
  ]) {
    expect(isValidCustomDomain(host), host).toBe(true)
  }
  for (const host of [
    '',
    'localhost',
    'https://api.example.com',
    'api.example.com/v1',
    'api.example.com:8787',
    '*.example.com',
    '-api.example.com',
    'api-.example.com',
  ]) {
    expect(isValidCustomDomain(host), host).toBe(false)
  }
})

it('adds a custom-domain route to a config that has none', () => {
  const result = addCustomDomainRoute('{"name":"worker"}', 'api.example.com')
  expect(parse(result).routes).toEqual([{ pattern: 'api.example.com', custom_domain: true }])
})

it('appends rather than replacing routes the project already declares', () => {
  const text = '{"name":"worker","routes":[{"pattern":"old.example.com","custom_domain":true}]}'
  const result = addCustomDomainRoute(text, 'api.example.com')
  expect(parse(result).routes).toEqual([
    { pattern: 'old.example.com', custom_domain: true },
    { pattern: 'api.example.com', custom_domain: true },
  ])
})

it('reads only custom-domain routes, ignoring pattern routes and other environments', () => {
  const text = `{
    "name": "production",
    "routes": [
      { "pattern": "example.com/api/*", "zone_name": "example.com" },
      { "pattern": "api.example.com", "custom_domain": true }
    ],
    "env": { "staging": { "routes": [{ "pattern": "staging.example.com", "custom_domain": true }] } }
  }`
  expect(readCustomDomains(text)).toEqual(['api.example.com'])
})

it('reports no custom domains for a config without routes', () => {
  expect(readCustomDomains('{"name":"worker"}')).toEqual([])
})
