import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { expect, it } from 'vitest'
import { defineBackend } from '../src/index.js'
import {
  agentModels,
  createAgentDefinition,
  parseAgentMarkdown,
  serializeAgentMarkdown,
  agentToolSchema,
} from '../src/agents/index.js'
import { createServerClient } from '../src/server/client.js'
import { compileConfig } from '../src/server/compile/index.js'
import { schemaStatements } from '../src/server/schema-sql.js'

it('round-trips agent instructions, local runtime and complete tool declarations', () => {
  const definition = {
    ...createAgentDefinition('Assistant'),
    runtime: 'codex' as const,
    localModel: 'local-model',
    tools: [
      {
        id: 'search',
        name: 'search',
        description: 'Search',
        enabled: true,
        parameters: [
          { name: 'query', type: 'string' as const, description: 'Query', required: true },
        ],
      },
    ],
  }
  expect(parseAgentMarkdown(serializeAgentMarkdown(definition))).toEqual(definition)
  expect(
    parseAgentMarkdown('---\ntools: [search]\n---\n# Searcher', definition).tools[0]?.enabled,
  ).toBe(true)
  expect(() => parseAgentMarkdown('---\ntools: [missing]\n---\n# Searcher', definition)).toThrow(
    'Add a tool declaration',
  )
  for (const provider of ['openai', 'anthropic', 'google'] as const) {
    expect(agentToolSchema(definition.tools[0]!, provider).name).toBe('search')
  }
})

it('enforces owner isolation and derives names during agent CRUD', async () => {
  const config = defineBackend({ models: { ...agentModels } })
  const sqlite = new Database(':memory:')
  try {
    for (const entry of schemaStatements(compileConfig(config))) sqlite.exec(entry.sql)
    const db = drizzle(sqlite)
    const opts = { db: { id: 'agents-test', connect: () => db } }
    const request = new Request('http://localhost/api/agents')
    const owner = createServerClient(config, { request, user: { id: 1 } }, opts)
    const other = createServerClient(config, { request, user: { id: 2 } }, opts)
    const input = createAgentDefinition('Assistant')
    const created = await owner.agent.create({ ...input, name: 'Forged', ownerId: 2 })
    expect(created).toMatchObject({ name: 'Assistant', ownerId: 1 })
    expect((await other.agent.list()).totalCount).toBe(0)
    await expect(other.agent.update(created.id, { markdown: '# Stolen' })).rejects.toThrow()
    const updated = await owner.agent.update(created.id, { markdown: '# Renamed', ownerId: 2 })
    expect(updated).toMatchObject({ name: 'Renamed', ownerId: 1 })
    await expect(
      owner.agent.update(created.id, { status: 'active', toolChoice: 'required' }),
    ).rejects.toThrow()
    await owner.agent.delete(created.id)
    expect((await owner.agent.list()).totalCount).toBe(0)
  } finally {
    sqlite.close()
  }
})
