import { readEnv } from '../server/auth/env.js'

/** Historical key name is preserved for applications already deployed with agents. */
export const AZURE_DURABLE_KEY = 'CLOUDCONFIG_AZURE_AGENT_KEY'

export async function azureDurableCommand<T>(options: {
  env: Record<string, unknown> | undefined
  endpointEnv: string
  action: string
  input: unknown
  timeoutMs?: number
}): Promise<T> {
  const endpoint = readEnv(options.endpointEnv, options.env)
  const key = readEnv(AZURE_DURABLE_KEY, options.env)
  if (!endpoint || !key) {
    throw new Error(
      `Azure durable execution requires ${options.endpointEnv} and ${AZURE_DURABLE_KEY}. Run cloudconfig deploy.`,
    )
  }
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('The Azure durable endpoint must use HTTPS.')
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-functions-key': key },
    body: JSON.stringify({ action: options.action, input: options.input }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    redirect: 'error',
  })
  if (!response.ok) {
    throw new Error(
      `Azure durable service returned ${response.status}. Check its Function logs and server credentials.`,
    )
  }
  return response.json() as Promise<T>
}
