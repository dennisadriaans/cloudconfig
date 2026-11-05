import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { buildProject, copyNextStandalone } from '../src/cli/deployment/build.js'
import { packageNodeEntry, zipDirectory } from '../src/cli/deployment/package.js'
import type { DeploymentRequest } from '../src/cli/deployment/ports.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it.each(['custom', 'configured'] as const)(
  'runs the packaged %s Vercel handler without its source project',
  async (mode) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-artifact-'))
    const artifact = mkdtempSync(join(tmpdir(), 'cloudconfig-runtime-'))
    directories.push(projectDir, artifact)
    writeFileSync(join(projectDir, 'package.json'), '{"type":"module"}')
    writeFileSync(join(projectDir, '.env'), 'PRIVATE_VALUE=must-never-ship')
    writeFileSync(
      join(projectDir, 'handler.ts'),
      `export default { async fetch(request) {
        if (request.headers.get('x-test-origin')) return new Response(request.url + '|' + await request.text())
        return new Response('portable handler')
      } }`,
    )
    mkdirSync(join(projectDir, 'node_modules', '@hono'), { recursive: true })
    symlinkSync(
      join(import.meta.dirname, '..', 'node_modules', '@hono', 'node-server'),
      join(projectDir, 'node_modules', '@hono', 'node-server'),
      'dir',
    )
    mkdirSync(join(projectDir, 'node_modules', '@cloudconfig'), { recursive: true })
    symlinkSync(
      join(import.meta.dirname, '..'),
      join(projectDir, 'node_modules', '@cloudconfig', 'core'),
      'dir',
    )
    writeFileSync(
      join(projectDir, 'cloud.config.ts'),
      `import { defineBackend, model, t } from '@cloudconfig/core'
export const config = defineBackend({ models: { note: model({ title: t.text() }) } })`,
    )
    const request: DeploymentRequest = {
      projectDir,
      configPath: join(projectDir, 'cloud.config.ts'),
      config: { models: {}, ...(mode === 'custom' ? { deploy: { entry: 'handler.ts' } } : {}) },
      framework: 'standalone',
      target: 'vercel',
      name: 'notes-app',
      options: {},
    }
    await buildProject(request, {})
    const entry = await packageNodeEntry(
      join(projectDir, '.cloudconfig', 'build', 'vercel', 'index.mjs'),
      artifact,
    )
    rmSync(projectDir, { recursive: true, force: true })
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { createServer, request as nodeRequest } from 'node:http'
    const { default: handler } = await import(${JSON.stringify(pathToFileURL(join(artifact, entry)).href)})
    const server = createServer(handler)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/_docs')
      console.log(await response.text())
      if (${JSON.stringify(mode)} === 'custom') {
        process.env.VERCEL = '1'
        const forwarded = await new Promise((resolve, reject) => {
          const request = nodeRequest('http://127.0.0.1:' + server.address().port + '/api/echo', {
            method: 'POST', headers: { host: 'notes.vercel.app', 'x-test-origin': 'true' },
          }, async response => {
            const chunks = []
            for await (const chunk of response) chunks.push(chunk)
            resolve(Buffer.concat(chunks).toString())
          })
          request.on('error', reject)
          request.end('preserved-body')
        })
        console.log(forwarded)
      }
    } finally { server.closeAllConnections(); server.close() }
  `,
      ],
      { cwd: artifact, encoding: 'utf8', timeout: 15_000 },
    )
    if (mode === 'custom') {
      expect(output.trim()).toBe(
        'portable handler\nhttps://notes.vercel.app/api/echo|preserved-body',
      )
    } else expect(output).toContain('SwaggerUIBundle')
    const zip = join(tmpdir(), `cloudconfig-artifact-${mode}-${Date.now()}.zip`)
    try {
      await zipDirectory(artifact, zip)
      const contents = readFileSync(zip)
      expect(contents.includes(Buffer.from('cloudconfig-symlinks.json'))).toBe(true)
      expect(contents.includes(Buffer.from('must-never-ship'))).toBe(false)
      expect(existsSync(join(artifact, '.env'))).toBe(false)
    } finally {
      rmSync(zip, { force: true })
    }
  },
  30_000,
)

it('relocates absolute Next workspace links into the standalone runtime', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-next-links-'))
  const artifact = mkdtempSync(join(tmpdir(), 'cloudconfig-next-links-runtime-'))
  directories.push(projectDir, artifact)
  const output = join(projectDir, '.next', 'standalone')
  mkdirSync(join(output, 'node_modules'), { recursive: true })
  mkdirSync(join(output, '.store', 'example'), { recursive: true })
  mkdirSync(join(projectDir, '.store', 'example'), { recursive: true })
  mkdirSync(join(projectDir, '.next', 'static'), { recursive: true })
  writeFileSync(
    join(output, '.store', 'example', 'index.js'),
    "module.exports = 'relocated package'",
  )
  symlinkSync(join(projectDir, '.store', 'example'), join(output, 'node_modules', 'example'), 'dir')
  writeFileSync(join(output, 'server.js'), "module.exports = require('example')")
  writeFileSync(
    join(projectDir, '.next', 'required-server-files.json'),
    JSON.stringify({
      appDir: projectDir,
      config: { output: 'standalone', outputFileTracingRoot: projectDir },
    }),
  )
  const entry = copyNextStandalone(
    {
      projectDir,
      configPath: '',
      config: { models: {} },
      framework: 'next',
      target: 'azure',
      name: 'notes-app',
      options: {},
    },
    artifact,
  )
  rmSync(projectDir, { recursive: true, force: true })
  const stdout = execFileSync(
    process.execPath,
    ['-e', 'console.log(require(process.argv[1]))', join(artifact, entry)],
    { encoding: 'utf8' },
  )
  expect(stdout.trim()).toBe('relocated package')
})
