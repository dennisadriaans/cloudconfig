/**
 * Port parsing and bind-failure messages for `cloudconfig dev`.
 */
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import type { Http2Server, Http2SecureServer } from 'node:http2'

export type DevServer = HttpServer | Http2Server | Http2SecureServer

export function parseDevPort(raw: string): number {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid port "${raw}". Use an integer between 1 and 65535 (e.g. cloudconfig dev --port 3001).`,
    )
  }
  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port "${raw}". Use an integer between 1 and 65535 (e.g. cloudconfig dev --port 3001).`,
    )
  }
  return port
}

export function portInUseMessage(port: number): string {
  const suggestion = port === 3000 ? 3001 : Math.min(port + 1, 65535)
  return (
    `Port ${port} is already in use.\n` +
    `Try another port: cloudconfig dev --port ${suggestion}\n` +
    `Or stop the process that is listening on ${port}.`
  )
}

export function isPortInUseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
  )
}

// Matches `@hono/node-server`'s `serve` shape without importing its option types.
export type ServeLike = (
  options: { fetch: (...args: never[]) => unknown; port: number },
  listeningListener?: (info: AddressInfo) => void,
) => DevServer

/**
 * Start `@hono/node-server`'s `serve` and resolve only after the port is bound.
 * Rejects with an actionable message when the port is already taken.
 */
export function listenDevServer(
  serve: ServeLike,
  fetch: (...args: never[]) => unknown,
  port: number,
): Promise<DevServer> {
  return new Promise((resolve, reject) => {
    let settled = false
    const server = serve({ fetch, port }, () => {
      if (settled) return
      settled = true
      resolve(server)
    })
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      if (isPortInUseError(err)) {
        reject(new Error(portInUseMessage(port)))
        return
      }
      reject(err)
    })
  })
}
