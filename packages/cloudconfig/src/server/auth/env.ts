/**
 * Reading configuration out of "the environment", which is two different places
 * depending on where the backend runs: Cloudflare hands bindings and secrets to
 * the request as `env`, Node puts them on `process.env`. Everything auth-related
 * reads through here so a secret set one way is never invisible the other way.
 */
export function readEnv(
  name: string,
  env: Record<string, unknown> | undefined,
): string | undefined {
  const fromPlatform = env?.[name]
  if (typeof fromPlatform === 'string' && fromPlatform !== '') return fromPlatform
  const fromProcess = globalThis.process?.env?.[name]
  return typeof fromProcess === 'string' && fromProcess !== '' ? fromProcess : undefined
}

/**
 * Development is a POSITIVE signal, never the absence of one.
 *
 * A Worker deployed without `nodejs_compat` has no `process.env` at all, so
 * "NODE_ENV is not 'production'" would call production a development machine —
 * and the development identity provider would be reachable in production. An
 * unknown environment is therefore treated as production.
 */
export function isDevelopment(env: Record<string, unknown> | undefined): boolean {
  const value = readEnv('NODE_ENV', env)
  return value === 'development'
}
