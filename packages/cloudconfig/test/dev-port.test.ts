import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isPortInUseError,
  listenDevServer,
  parseDevPort,
  portInUseMessage,
  type DevServer,
  type ServeLike,
} from '../src/cli/dev-port.js'
import { formatCliError } from '../src/cli/format-error.js'

/** Local `serve` stand-in that binds 127.0.0.1 so conflict tests are deterministic. */
const serveLocalhost: ServeLike = (options, listeningListener) => {
  const server = createServer((_req, res) => res.end())
  server.listen(options.port, '127.0.0.1', () => {
    listeningListener?.(server.address() as AddressInfo)
  })
  return server
}

async function listenEphemeral(): Promise<{
  server: ReturnType<typeof createServer>
  port: number
}> {
  const server = createServer((_req, res) => res.end())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  return { server, port: address.port }
}

async function closeServer(server: {
  close: (cb: (err?: Error | null) => void) => void
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

describe('parseDevPort', () => {
  it('accepts integers in the valid TCP range', () => {
    expect(parseDevPort('3000')).toBe(3000)
    expect(parseDevPort('1')).toBe(1)
    expect(parseDevPort('65535')).toBe(65535)
    expect(parseDevPort(' 8080 ')).toBe(8080)
  })

  it('rejects non-integers and out-of-range values', () => {
    for (const raw of ['', 'abc', '30.5', '0', '65536', '-1', '3e3']) {
      expect(() => parseDevPort(raw)).toThrow(/Invalid port/)
      expect(() => parseDevPort(raw)).toThrow(/cloudconfig dev --port 3001/)
    }
  })
})

describe('portInUseMessage', () => {
  it('suggests 3001 when the default port is taken', () => {
    const msg = portInUseMessage(3000)
    expect(msg).toContain('Port 3000 is already in use')
    expect(msg).toContain('cloudconfig dev --port 3001')
    expect(msg).toContain('stop the process')
  })

  it('suggests the next port for other values', () => {
    expect(portInUseMessage(4000)).toContain('cloudconfig dev --port 4001')
  })
})

describe('isPortInUseError', () => {
  it('matches EADDRINUSE errno exceptions', () => {
    expect(isPortInUseError(Object.assign(new Error('listen'), { code: 'EADDRINUSE' }))).toBe(true)
    expect(isPortInUseError(new Error('other'))).toBe(false)
    expect(isPortInUseError(null)).toBe(false)
  })
})

describe('formatCliError port-in-use', () => {
  it('rewrites raw EADDRINUSE errors with a --port hint', () => {
    const err = Object.assign(new Error('listen EADDRINUSE'), {
      code: 'EADDRINUSE',
      port: 3000,
    })
    const msg = formatCliError(err, '/tmp')
    expect(msg).toContain('Port 3000 is already in use')
    expect(msg).toContain('cloudconfig dev --port 3001')
  })
})

describe('listenDevServer', () => {
  let opened: DevServer | undefined

  afterEach(async () => {
    if (opened) {
      await closeServer(opened)
      opened = undefined
    }
  })

  it('resolves after the port is bound', async () => {
    const { server: probe, port } = await listenEphemeral()
    await closeServer(probe)

    opened = await listenDevServer(serveLocalhost, async () => new Response('ok'), port)
    expect(opened.listening).toBe(true)
  })

  it('rejects with an actionable hint when the port is taken', async () => {
    const { server: blocker, port } = await listenEphemeral()
    try {
      await expect(
        listenDevServer(serveLocalhost, async () => new Response('ok'), port),
      ).rejects.toThrow(portInUseMessage(port))
    } finally {
      await closeServer(blocker)
    }
  })

  it('rejects non-EADDRINUSE listen errors unchanged', async () => {
    const boom = Object.assign(new Error('listen EACCES'), { code: 'EACCES' })
    const serveFail: ServeLike = () => {
      const server = createServer()
      queueMicrotask(() => {
        server.emit('error', boom)
      })
      return server
    }
    await expect(listenDevServer(serveFail, async () => new Response('ok'), 1)).rejects.toBe(boom)
  })
})
