import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { defineBackend, model, t, type AnyConfig } from '../src/index.js'
import { createMcpServer, type McpServerOptions } from '../src/server/mcp.js'
import type { Db, DbProvider } from '../src/server/driver.js'

type TestUser = { id: number; email: string }

function makeConfig(options?: Parameters<typeof model>[1]) {
  return defineBackend({
    models: {
      user: model({
        name: t.text().required(),
        email: t.email().required().unique(),
      }),
      post: model(
        {
          title: t.text().required(),
          body: t.textarea(),
          status: t.select(['draft', 'published']).default('draft'),
          author: t.relation('user'),
        },
        options,
      ),
    },
    access: { default: 'allow' },
  })
}

function freshDb(): DbProvider {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT, status TEXT DEFAULT 'draft', author_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `)
  const db: Db = drizzle(sqlite)
  return { id: 'test', connect: (): Db => db }
}

async function connectClient(
  config: AnyConfig,
  options: McpServerOptions<TestUser> = { allowAnonymous: true },
  authInfo?: AuthInfo,
): Promise<Client> {
  const server = createMcpServer(config, {
    ...options,
    db: freshDb(),
  } as McpServerOptions<TestUser>)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  serverTransport.sessionId = 'test-session'
  if (authInfo) {
    const send = clientTransport.send.bind(clientTransport)
    clientTransport.send = (message, sendOptions) => send(message, { ...sendOptions, authInfo })
  }
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** Parse the JSON text a successful CRUD tool returns. */
function payload(result: CallToolResult): unknown {
  const first = result.content[0]
  return first && first.type === 'text' ? JSON.parse(first.text) : undefined
}

describe('MCP auth options', () => {
  it('denies anonymous list and create without access rules', async () => {
    const client = await connectClient(
      defineBackend({ models: { post: model({ title: t.text().required() }) } }),
    )
    for (const [name, args] of [
      ['posts_list', {}],
      ['posts_create', { title: 'Denied' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).toBe(true)
    }
    await client.close()
  })

  it('applies scoped where predicates to MCP lists', async () => {
    const client = await connectClient(
      makeConfig({ access: { list: ({ where }) => where('status', 'eq', 'published') } }),
    )
    await client.callTool({
      name: 'posts_create',
      arguments: { title: 'Private', status: 'draft' },
    })
    await client.callTool({
      name: 'posts_create',
      arguments: { title: 'Public', status: 'published' },
    })
    const result = (await client.callTool({ name: 'posts_list', arguments: {} })) as CallToolResult
    expect(payload(result)).toMatchObject({ totalCount: 1, data: [{ title: 'Public' }] })
    await client.close()
  })
  it('refuses to construct with no identity mode at all', () => {
    expect(() =>
      createMcpServer(makeConfig(), { db: freshDb() } as McpServerOptions<TestUser>),
    ).toThrow(/exactly one of getUser, principal, or allowAnonymous/)
  })

  it('refuses to construct with more than one identity mode', () => {
    expect(() =>
      createMcpServer(makeConfig(), {
        db: freshDb(),
        allowAnonymous: true,
        getUser: async () => ({ id: 1, email: 'a@x.com' }),
      } as unknown as McpServerOptions<TestUser>),
    ).toThrow(/exactly one of getUser, principal, or allowAnonymous/)
  })

  it('refuses a null principal rather than silently going anonymous', () => {
    expect(() =>
      createMcpServer(makeConfig(), {
        db: freshDb(),
        principal: null,
      } as unknown as McpServerOptions<TestUser>),
    ).toThrow(/principal must not be null or undefined/)
  })

  it('constructs with each single identity mode', () => {
    expect(() =>
      createMcpServer(makeConfig(), { db: freshDb(), allowAnonymous: true }),
    ).not.toThrow()
    expect(() =>
      createMcpServer(makeConfig(), { db: freshDb(), principal: { id: 1, email: 'a@x.com' } }),
    ).not.toThrow()
    expect(() =>
      createMcpServer(makeConfig(), {
        db: freshDb(),
        getUser: async () => ({ id: 1, email: 'a@x.com' }),
      }),
    ).not.toThrow()
  })
})

describe('MCP transport', () => {
  let client: Client

  beforeEach(async () => {
    client = await connectClient(makeConfig())
  })

  it('advertises five tools per model plus describe_schema', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((x) => x.name).sort()
    expect(names).toEqual(
      [
        'describe_schema',
        'posts_create',
        'posts_delete',
        'posts_get',
        'posts_list',
        'posts_update',
        'users_create',
        'users_delete',
        'users_get',
        'users_list',
        'users_update',
      ].sort(),
    )
    const create = tools.find((x) => x.name === 'posts_create')
    expect(create?.inputSchema.type).toBe('object')
  })

  it('describes every model, its fields and its REST endpoints', async () => {
    const schema = payload(
      (await client.callTool({ name: 'describe_schema', arguments: {} })) as CallToolResult,
    ) as {
      models: {
        name: string
        plural: string
        fields: { name: string; required: boolean }[]
        endpoints: { list: string }
      }[]
    }
    const post = schema.models.find((m) => m.name === 'post')
    expect(post?.plural).toBe('posts')
    expect(post?.endpoints.list).toBe('GET /api/posts')
    expect(post?.fields.some((f) => f.name === 'title' && f.required)).toBe(true)
  })

  it('creates, reads, updates, lists and deletes a record', async () => {
    const created = payload(
      (await client.callTool({
        name: 'users_create',
        arguments: { name: 'Ada', email: 'ada@x.com' },
      })) as CallToolResult,
    ) as { id: number; name: string }
    expect(created.id).toBe(1)
    expect(created.name).toBe('Ada')

    const got = payload(
      (await client.callTool({ name: 'users_get', arguments: { id: 1 } })) as CallToolResult,
    ) as { email: string }
    expect(got.email).toBe('ada@x.com')

    const updated = payload(
      (await client.callTool({
        name: 'users_update',
        arguments: { id: 1, name: 'Ada L.' },
      })) as CallToolResult,
    ) as { name: string }
    expect(updated.name).toBe('Ada L.')

    const listed = payload(
      (await client.callTool({ name: 'users_list', arguments: {} })) as CallToolResult,
    ) as { data: unknown[]; totalCount: number }
    expect(listed.totalCount).toBe(1)
    expect(listed.data).toHaveLength(1)

    const del = (await client.callTool({
      name: 'users_delete',
      arguments: { id: 1 },
    })) as CallToolResult
    expect(del.isError).toBeFalsy()

    const afterList = payload(
      (await client.callTool({ name: 'users_list', arguments: {} })) as CallToolResult,
    ) as { totalCount: number }
    expect(afterList.totalCount).toBe(0)
  })

  it('reports validation errors as tool errors', async () => {
    const res = (await client.callTool({
      name: 'users_create',
      arguments: { name: 'NoEmail' },
    })) as CallToolResult
    expect(res.isError).toBe(true)
    const first = res.content[0]
    expect(first && first.type === 'text' && first.text).toContain('Validation failed')
  })

  it('reports a missing record as not found', async () => {
    const res = (await client.callTool({
      name: 'users_get',
      arguments: { id: 999 },
    })) as CallToolResult
    expect(res.isError).toBe(true)
    const first = res.content[0]
    expect(first && first.type === 'text' && first.text).toContain('Not found')
  })

  it('honors access rules (deny surfaces as forbidden)', async () => {
    const denied = await connectClient(makeConfig({ access: { create: () => false } }))
    const res = (await denied.callTool({
      name: 'posts_create',
      arguments: { title: 'Hi' },
    })) as CallToolResult
    expect(res.isError).toBe(true)
    const first = res.content[0]
    expect(first && first.type === 'text' && first.text).toContain('Forbidden')
  })

  it('authenticates MCP bearer callers before access rules run', async () => {
    const requests: Request[] = []
    const config = makeConfig({
      access: { list: ({ user }) => (user as TestUser | null)?.id === 7 },
    })
    const options: McpServerOptions<TestUser> = {
      getUser: (request) => {
        requests.push(request)
        return request.headers.get('authorization') === 'Bearer valid-token'
          ? { id: 7, email: 'agent@x.com' }
          : null
      },
    }

    const unauthenticated = await connectClient(config, options)
    await expect(unauthenticated.listTools()).rejects.toThrow('Unauthorized')
    await expect(unauthenticated.callTool({ name: 'unknown_tool', arguments: {} })).rejects.toThrow(
      'Unauthorized',
    )

    const authenticated = await connectClient(config, options, {
      token: 'valid-token',
      clientId: 'agent-client',
      scopes: ['cloudconfig:read'],
    })
    await authenticated.listTools()
    const result = (await authenticated.callTool({
      name: 'posts_list',
      arguments: {},
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    expect(requests.at(-1)?.headers.get('x-cloudconfig-mcp-client-id')).toBe('agent-client')
    expect(requests.at(-1)?.headers.get('x-cloudconfig-mcp-scopes')).toBe('cloudconfig:read')
    expect(requests.at(-1)?.headers.get('x-cloudconfig-mcp-session-id')).toBe('test-session')
  })

  it('passes the authenticated user to mutation hooks', async () => {
    const hookUsers: unknown[] = []
    const config = makeConfig({
      access: { create: ({ user }) => user != null },
      hooks: {
        beforeCreate: ({ user }, input) => {
          hookUsers.push(user)
          return input
        },
        afterChange: ({ user }) => {
          hookUsers.push(user)
        },
      },
    })
    const authenticated = await connectClient(
      config,
      {
        getUser: (request) =>
          request.headers.get('authorization') === 'Bearer valid-token'
            ? { id: 7, email: 'agent@x.com' }
            : null,
      },
      { token: 'valid-token', clientId: 'agent-client', scopes: ['cloudconfig:write'] },
    )

    await authenticated.callTool({
      name: 'posts_create',
      arguments: { title: 'Authenticated' },
    })

    expect(hookUsers).toEqual([
      { id: 7, email: 'agent@x.com' },
      { id: 7, email: 'agent@x.com' },
    ])
  })

  it('refuses anonymous mode on a network transport', async () => {
    const server = createMcpServer(makeConfig(), {
      db: freshDb(),
      allowAnonymous: true,
    })
    const networkTransport: Transport = {
      start: async () => undefined,
      send: async () => undefined,
      close: async () => undefined,
    }
    Object.defineProperty(networkTransport, 'constructor', {
      value: { name: 'StdioServerTransport' },
    })

    await expect(server.connect(networkTransport)).rejects.toThrow(
      'Network MCP transports require getUser',
    )
  })
})

describe('MCP identity', () => {
  it('denies callers when access requires a user and identity is anonymous', async () => {
    const client = await connectClient(makeConfig({ access: { create: ({ user }) => !!user } }), {
      allowAnonymous: true,
    })
    const res = (await client.callTool({
      name: 'posts_create',
      arguments: { title: 'Secret' },
    })) as CallToolResult
    expect(res.isError).toBe(true)
    const first = res.content[0]
    expect(first && first.type === 'text' && first.text).toContain('Forbidden')
  })

  it('allows authenticated callers through access rules that require a user', async () => {
    const principal: TestUser = { id: 7, email: 'ada@x.com' }
    const client = await connectClient(makeConfig({ access: { create: ({ user }) => !!user } }), {
      principal,
    })
    const res = (await client.callTool({
      name: 'posts_create',
      arguments: { title: 'Hello' },
    })) as CallToolResult
    expect(res.isError).toBeFalsy()
    const created = payload(res) as { title: string }
    expect(created.title).toBe('Hello')
  })

  it('resolves getUser from the per-request bearer token (shared with REST-style auth)', async () => {
    const client = await connectClient(
      makeConfig({ access: { create: ({ user }) => !!user } }),
      {
        getUser: async (request) => {
          const auth = request.headers.get('authorization')
          if (auth === 'Bearer secret-token') return { id: 1, email: 'bearer@x.com' }
          return null
        },
      },
      { token: 'secret-token', clientId: 'test-client', scopes: [] },
    )
    const ok = (await client.callTool({
      name: 'posts_create',
      arguments: { title: 'Authed' },
    })) as CallToolResult
    expect(ok.isError).toBeFalsy()
  })

  it('passes the resolved user into hooks', async () => {
    const seen: unknown[] = []
    const principal: TestUser = { id: 3, email: 'hook@x.com' }
    const config = defineBackend({
      access: { default: 'allow' },
      models: {
        post: model(
          { title: t.text().required() },
          {
            hooks: {
              beforeCreate: (ctx, input) => {
                seen.push(ctx.user)
                return input
              },
            },
          },
        ),
      },
    })
    const client = await connectClient(config, { principal })
    const res = (await client.callTool({
      name: 'posts_create',
      arguments: { title: 'Tracked' },
    })) as CallToolResult
    expect(res.isError).toBeFalsy()
    expect(seen).toEqual([principal])
  })
})

describe('MCP application contributions', () => {
  it('keeps bootstrap diagnostics available without exposing private tools', async () => {
    const { createMcpToolRegistry } = await import('../src/mcp.js')
    const registry = createMcpToolRegistry()
    registry.registerTool(
      'project_info',
      {
        description: 'Public setup status',
        inputSchema: {},
        public: true,
      },
      () => ({ content: [{ type: 'text', text: 'Sign in first.' }] }),
    )
    let user: TestUser | null = null
    const client = await connectClient(makeConfig(), {
      getUser: () => user,
      tools: registry.tools,
    })
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['project_info'])
    expect((await client.callTool({ name: 'project_info' })).isError).not.toBe(true)
    await expect(client.callTool({ name: 'posts_list' })).rejects.toThrow(/Unauthorized/)
    user = { id: 1, email: 'a@x.com' }
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('posts_create')
    user = null
    await expect(
      client.callTool({ name: 'posts_create', arguments: { title: 'Denied' } }),
    ).rejects.toThrow(/Unauthorized/)
    await client.close()
  })

  it('validates contributions and rejects collisions unless generated tools are selected out', async () => {
    const { createMcpToolRegistry } = await import('../src/mcp.js')
    const { z } = await import('zod')
    const registry = createMcpToolRegistry()
    registry.registerTool(
      'posts_create',
      {
        description: 'Specialized creation',
        inputSchema: { title: z.string().min(1) },
      },
      ({ title }, context) => ({
        content: [{ type: 'text', text: JSON.stringify({ title, user: context.user }) }],
      }),
    )
    expect(() =>
      createMcpServer(makeConfig(), {
        allowAnonymous: true,
        db: freshDb(),
        tools: registry.tools,
      }),
    ).toThrow(/Duplicate MCP tool/)
    const client = await connectClient(makeConfig(), {
      principal: { id: 1, email: 'a@x.com' },
      tools: registry.tools,
      includeTool: (tool) => tool.name !== 'posts_create',
    })
    expect(
      (await client.callTool({ name: 'posts_create', arguments: { title: '' } })).isError,
    ).toBe(true)
    expect(
      payload(
        (await client.callTool({
          name: 'posts_create',
          arguments: { title: 'Valid' },
        })) as CallToolResult,
      ),
    ).toMatchObject({ title: 'Valid', user: { id: 1 } })
    await client.close()
  })
})

it('restricts a local account resolver to process-local transports', async () => {
  const server = createMcpServer(makeConfig(), {
    db: freshDb(),
    getUser: () => ({ id: 1 }),
    localOnly: true,
  })
  const transport: Transport = {
    start: async () => undefined,
    send: async () => undefined,
    close: async () => undefined,
  }
  await expect(server.connect(transport)).rejects.toThrow(/process-local only/)
})

it('passes transformed extension inputs to the handler exactly once', async () => {
  const { createMcpToolRegistry } = await import('../src/mcp.js')
  const { z } = await import('zod')
  const registry = createMcpToolRegistry()
  registry.registerTool(
    'parse_count',
    {
      description: 'Parse a count',
      inputSchema: { count: z.string().transform(Number) },
    },
    ({ count }) => ({ content: [{ type: 'text', text: JSON.stringify({ count }) }] }),
  )
  const client = await connectClient(makeConfig(), { allowAnonymous: true, tools: registry.tools })
  expect(
    payload(
      (await client.callTool({ name: 'parse_count', arguments: { count: '5' } })) as CallToolResult,
    ),
  ).toEqual({ count: 5 })
  await client.close()
})
