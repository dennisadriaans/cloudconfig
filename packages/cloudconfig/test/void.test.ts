import { describe, expect, it } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import type { OpenApiDocument } from '../src/server/openapi.js'
import { createVoidBackend } from '../src/void/server.js'
import { createVoidTools } from '../src/void/tools.js'
import { createVoidMcpServer } from '../src/void/mcp.js'

const config = defineBackend({
  models: {
    note: model({ title: t.text().required(), internalToken: t.text().serverOnly() }),
  },
})

describe('Void runtime adapters', () => {
  it('generates REST documentation without opening a D1 connection', async () => {
    const response = await createVoidBackend(config).request('/api/openapi.json')
    expect(response.status).toBe(200)
    const document: OpenApiDocument = await response.json()
    expect(document.paths['/notes']?.get?.operationId).toBeDefined()
    expect(document.paths['/notes']?.post?.operationId).toBeDefined()
  })

  it('serves HEAD through its GET routes without a response body', async () => {
    const response = await createVoidBackend(config).request('/api/openapi.json', {
      method: 'HEAD',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.text()).toBe('')
  })

  it('generates the model tool vocabulary without exposing server-only fields', () => {
    const tools = createVoidTools(config, { request: new Request('http://localhost/tools') })
    expect(tools.map(({ name }) => name)).toContain('notes_create')
    expect(tools.map(({ name }) => name)).toContain('notes_list')
    const create = tools.find(({ name }) => name === 'notes_create')!
    expect(create.action).toBe('create')
    expect(create.inputSchema).toHaveProperty('properties.title')
    expect(create.inputSchema).not.toHaveProperty('properties.internalToken')
  })

  it('rejects invalid tool arguments before connecting to D1', async () => {
    const tools = createVoidTools(config, { request: new Request('http://localhost/tools') })
    const create = tools.find(({ name }) => name === 'notes_create')!
    const result = await create.execute({ internalToken: 'should-not-enter-the-tool-boundary' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('validation')
  })

  it('retains default-deny access rules without issuing a database statement', async () => {
    const env = {
      DB: {
        prepare: () => {
          throw new Error('Denied tools must not query D1.')
        },
      },
    }
    const tools = createVoidTools(config, { request: new Request('http://localhost/tools'), env })
    const list = tools.find(({ name }) => name === 'notes_list')!
    const result = await list.execute({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('forbidden')
  })

  it('does not permit fixed-principal MCP authentication over a network transport', async () => {
    const server = createVoidMcpServer(config, { principal: { id: 1 } })
    await expect(
      server.connect({
        start: async () => {},
        send: async () => {},
        close: async () => {},
      }),
    ).rejects.toThrow(/getUser/)
  })
})
