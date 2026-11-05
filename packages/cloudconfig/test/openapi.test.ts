import { describe, expect, it } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { compileConfig } from '../src/server/compile/index.js'
import { buildOpenApiDocument, type OpenApiDocument } from '../src/server/openapi.js'

const config = defineBackend({
  access: { default: 'allow' },
  models: {
    author: model({ name: t.text().required(), email: t.email(), secret: t.text() }),
    post: model({
      title: t.text().required(),
      body: t.textarea(),
      status: t.select(['draft', 'published']).required().default('draft'),
      tags: t.multiselect(['one', 'two']),
      count: t.number(),
      rating: t.float(),
      published: t.boolean(),
      date: t.date(),
      scheduledAt: t.datetime(),
      url: t.url(),
      metadata: t.json(),
      default: t.json(),
      author: t.relation('author').required(),
    }),
    label: model({ name: t.text() }, { timestamps: false }),
  },
})

describe('OpenAPI model contract', () => {
  it('describes all CRUD methods, list parameters, status codes, and empty deletes', () => {
    const doc = buildOpenApiDocument(compileConfig(config))
    expect(doc.openapi).toBe('3.1.1')
    expect(doc.servers).toEqual([{ url: '/api' }])
    expect(Object.keys(doc.paths['/posts']!)).toEqual(['get', 'post'])
    const single = doc.paths['/posts/{id}']!
    expect(Object.keys(single)).toEqual(['get', 'put', 'patch', 'delete'])
    expect(single.put?.requestBody).toEqual(single.patch?.requestBody)
    expect(single.put?.operationId).not.toBe(single.patch?.operationId)
    expect(single.get?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
    ])
    expect(single.delete?.responses['204']).toEqual({
      description: 'Record deleted. No response body.',
    })
    expect(single.patch?.responses).toHaveProperty('404')
    expect(single.patch?.responses).not.toHaveProperty('403')
    expect(doc.paths['/posts']?.post?.responses).toHaveProperty('201')
    expect(doc.paths['/posts']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'pageSize',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            default: 20,
          },
        }),
        expect.objectContaining({
          name: 'filters',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/FilterGroup' } },
          },
        }),
      ]),
    )
    expect(doc.components.schemas['Model.post.Page']).toMatchObject({
      required: ['data', 'totalCount', 'page', 'pageSize', 'totalPages'],
      properties: { data: { items: { $ref: '#/components/schemas/Model.post.Row' } } },
    })
  })

  it('derives create and partial update schemas from validation', () => {
    const { schemas } = buildOpenApiDocument(compileConfig(config)).components
    expect(schemas['Model.post.Create']).toMatchObject({
      required: ['title', 'authorId'],
      properties: {
        title: { type: 'string' },
        status: { enum: ['draft', 'published'], default: 'draft' },
        tags: { type: 'array', items: { enum: ['one', 'two'] } },
        count: { type: 'integer' },
        rating: { type: 'number' },
        published: { type: 'boolean' },
        date: { format: 'date' },
        scheduledAt: { format: 'date-time' },
        url: { format: 'uri' },
        authorId: { type: 'integer' },
      },
    })
    expect(schemas['Model.post.Update']?.['required'] ?? []).toEqual([])
    const input = schemas['Model.post.Create']?.['properties']
    expect(input).not.toHaveProperty('id')
    expect(input).not.toHaveProperty('createdAt')
    expect(input).not.toHaveProperty('author')
  })

  it('describes nullable stored fields and the actual relation projection', () => {
    const { schemas } = buildOpenApiDocument(compileConfig(config)).components
    const properties = schemas['Model.post.Row']?.['properties'] as Record<string, unknown>
    expect(properties).toHaveProperty('id')
    expect(properties).toHaveProperty('createdAt')
    expect(properties).not.toHaveProperty('authorId')
    expect(properties['body']).toMatchObject({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    expect(properties['author']).toMatchObject({
      anyOf: [
        { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
        { type: 'null' },
      ],
    })
    expect(JSON.stringify(properties['author'])).not.toContain('secret')
    expect(schemas['Model.label.Row']?.['properties']).not.toHaveProperty('createdAt')
  })

  it('keeps recursive JSON references resolvable after embedding schemas', () => {
    const doc = buildOpenApiDocument(compileConfig(config))
    let references = 0
    function walk(value: unknown): void {
      if (!value || typeof value !== 'object') return
      const object = value as Record<string, unknown>
      if (typeof object['$ref'] === 'string') {
        references++
        expect(object['$ref']).toMatch(/^#\/components\/schemas\//)
        let target: unknown = doc
        for (const key of object['$ref'].slice(2).split('/')) {
          target = (target as Record<string, unknown> | undefined)?.[
            key.replace(/~1/g, '/').replace(/~0/g, '~')
          ]
        }
        expect(target, object['$ref']).toBeDefined()
      }
      Object.values(object).forEach(walk)
    }
    walk(doc)
    expect(references).toBeGreaterThan(0)
  })

  it('keeps internal auth models out of the public API and avoids running access rules', () => {
    const secured = defineBackend({
      auth: {},
      models: {
        post: model(
          { author: t.relation('user') },
          {
            access: {
              list: () => {
                throw new Error('Must not execute during documentation')
              },
            },
          },
        ),
      },
    })
    const doc = buildOpenApiDocument(compileConfig(secured))
    expect(Object.keys(doc.paths)).toEqual(['/posts', '/posts/aggregate', '/posts/{id}'])
    expect(Object.keys(doc.components.schemas)).not.toContain('Model.user.Row')
    expect(doc.components.securitySchemes?.['SecureSessionCookie']?.name).toBe(
      '__Secure-better-auth.session_token',
    )
    expect(doc.security).toContainEqual({})
    expect(
      buildOpenApiDocument(compileConfig(secured), { sessionAuth: false }).security,
    ).toBeUndefined()
  })
})

describe('docs routes', () => {
  it('serves OpenAPI before the model wildcard without a database', async () => {
    const app = createBackend(config)
    const response = await app.request('http://localhost/api/openapi.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(((await response.json()) as OpenApiDocument).openapi).toBe('3.1.1')
  })

  it.each(['/v2/', '/'])('follows an overridden mount %s in docs and OpenAPI', async (basePath) => {
    const app = createBackend(config, { basePath })
    const prefix = basePath.replace(/\/+$/, '')
    const response = await app.request(`http://localhost${prefix}/openapi.json`)
    const doc = (await response.json()) as OpenApiDocument
    expect(doc.servers).toEqual([{ url: prefix || '/' }])
    const html = await (await app.request(`http://localhost${prefix}/_docs`)).text()
    expect(html).toContain('SwaggerUIBundle')
    expect(html).toContain(`url: "${prefix}/openapi.json"`)
  })

  it('uses Swagger as the homepage fallback', async () => {
    const app = createBackend(config)
    const homepage = await app.request('http://localhost/')
    const docs = await app.request('http://localhost/api/_docs')
    expect(homepage.status).toBe(200)
    expect(await homepage.text()).toBe(await docs.text())
    expect((await app.request('http://localhost/missing')).status).toBe(404)
    expect((await app.request('http://localhost/', { method: 'POST' })).status).toBe(404)
  })

  it('preserves an explicitly registered homepage', async () => {
    const app = createBackend(config)
    app.get('/', (c) => c.html('<h1>My app</h1>'))
    const homepage = await app.request('http://localhost/')
    expect(await homepage.text()).toBe('<h1>My app</h1>')
    const docs = await app.request('http://localhost/api/_docs')
    expect(await docs.text()).toContain('SwaggerUIBundle')
  })

  it('disables the docs routes and homepage fallback with docs: false', async () => {
    const app = createBackend({ ...config, server: { docs: false } })
    expect((await app.request('http://localhost/')).status).toBe(404)
    expect((await app.request('http://localhost/api/_docs')).status).toBe(404)
    expect((await app.request('http://localhost/api/openapi.json')).status).toBe(404)
  })

  it.each([
    { configured: '/api', mounted: '/v2', authPath: '/v2/auth' },
    { configured: '/', mounted: '/v2', authPath: '/v2/auth' },
    { configured: '/api', mounted: '/', authPath: '/auth' },
  ])(
    'rebases auth routes with the API ($configured → $mounted)',
    async ({ configured, mounted, authPath }) => {
      const app = createBackend(
        { ...config, server: { basePath: configured }, auth: {} },
        { basePath: mounted },
      )
      expect(app.routes.some((route) => route.path === `${authPath}/*`)).toBe(true)
    },
  )
})
