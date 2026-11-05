import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'

export const STUDIO_PATH = '/_cloudconfig/studio'

export interface StudioOptions {
  projectDir: string
  /** The same SQLite file used by the application's dev backend. */
  databasePath: string
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const socket = createServer()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      socket.close((error) => {
        if (error) reject(error)
        else if (address && typeof address !== 'string') resolvePort(address.port)
        else reject(new Error('Could not reserve a Studio port.'))
      })
    })
  })
}

/** Node-only development tooling. Mount exclusively in a development server. */
export function createStudioDevtools(options: StudioOptions) {
  const root = resolve(options.projectDir)
  const database = resolve(root, options.databasePath)
  const require = createRequire(join(root, 'package.json'))
  let child: ChildProcess | undefined
  let connection: Promise<string> | undefined
  let directory: string | undefined
  let disposed = false

  function stopChild() {
    child?.kill()
  }

  process.once('exit', stopChild)

  async function launch(): Promise<string> {
    if (disposed) throw new Error('The development server is shutting down.')
    if (!existsSync(database)) {
      throw new Error('Local database is missing. Run cloudconfig db migrate first.')
    }
    let binary: string
    try {
      binary = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs')
    } catch {
      throw new Error(
        'Drizzle Studio needs drizzle-kit. Install it with pnpm add -D drizzle-kit, then retry.',
      )
    }

    const port = await availablePort()
    if (disposed) throw new Error('The development server is shutting down.')
    const cache = join(root, '.cloudconfig')
    mkdirSync(cache, { recursive: true })
    directory ??= mkdtempSync(join(cache, 'studio-'))
    const configPath = join(directory, 'drizzle.config.cjs')
    // No schema copy: Studio introspects the database the application actually uses.
    writeFileSync(
      configPath,
      `module.exports = ${JSON.stringify({
        dialect: 'sqlite',
        dbCredentials: { url: database },
      })}\n`,
    )

    return new Promise<string>((resolveReady, reject) => {
      const studio = spawn(
        process.execPath,
        [binary, 'studio', '--config', configPath, '--host', '127.0.0.1', '--port', String(port)],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      child = studio
      let ready = false
      let failure: Error | undefined
      let output = ''
      const timeout = setTimeout(() => {
        failure = new Error(
          'Studio took too long to start. Check the dev server terminal and retry.',
        )
        studio.kill('SIGKILL')
      }, 20_000)

      const onOutput = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8_000)
        if (output.includes('EADDRINUSE')) {
          failure = new Error(
            'The Studio port was taken by another process. Retry to use a new port.',
          )
          studio.kill()
        } else if (!ready && output.includes('Drizzle Studio is up and running')) {
          ready = true
          clearTimeout(timeout)
          resolveReady(`https://local.drizzle.studio?port=${port}`)
        }
      }
      studio.stdout.on('data', onOutput)
      studio.stderr.on('data', onOutput)
      studio.once('error', (error) => {
        failure = new Error(`Could not start Drizzle Studio: ${error.message}`)
      })
      // close also runs after a failed spawn, and after stdout/stderr are drained.
      studio.once('close', () => {
        clearTimeout(timeout)
        if (child === studio) {
          child = undefined
          connection = undefined
        }
        if (!ready) {
          if (output) console.error('[cloudconfig:studio]', output)
          reject(
            failure ??
              new Error(
                'Studio exited before connecting. Check the dev server terminal and retry.',
              ),
          )
        }
      })
    })
  }

  function start(): Promise<string> {
    connection ??= launch().catch((error: unknown) => {
      connection = undefined
      throw error
    })
    return connection
  }

  async function handle(request: Request): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store' }
    const url = new URL(request.url)
    if (disposed || process.env['NODE_ENV'] === 'production') {
      return new Response(null, { status: 404, headers })
    }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return Response.json(
        { message: 'Open Studio from your application on localhost.' },
        { status: 403, headers },
      )
    }
    if (url.pathname.endsWith('/client.js') && request.method === 'GET') {
      const script = readFileSync(
        new URL(import.meta.resolve('@cloudconfig/core/devtools/browser')),
        'utf8',
      )
      return new Response(script, { headers: { ...headers, 'Content-Type': 'text/javascript' } })
    }
    if (request.method !== 'POST') {
      return Response.json(
        { message: 'Use POST to open Studio.' },
        { status: 405, headers: { ...headers, Allow: 'POST' } },
      )
    }
    if (
      request.headers.get('origin') !== url.origin ||
      request.headers.get('x-cloudconfig-studio') !== 'open'
    ) {
      return Response.json(
        { message: 'Open Studio using the database icon in your application.' },
        { status: 403, headers },
      )
    }
    try {
      return Response.json({ url: await start() }, { headers })
    } catch (error) {
      return Response.json(
        { message: error instanceof Error ? error.message : 'Could not start Studio.' },
        { status: 503, headers },
      )
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    process.off('exit', stopChild)
    const running = child
    if (running) {
      await new Promise<void>((resolveClosed) => {
        const timeout = setTimeout(() => running.kill('SIGKILL'), 2_000)
        running.once('close', () => {
          clearTimeout(timeout)
          resolveClosed()
        })
        running.kill()
      })
    }
    if (directory) rmSync(directory, { recursive: true, force: true })
  }

  return { handle, dispose }
}
