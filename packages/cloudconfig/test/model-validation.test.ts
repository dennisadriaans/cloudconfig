import { describe, expect, it, vi } from 'vitest'
import { defineBackend, model, t, type ModelOptions, type ModelValidator } from '../src/index.js'
import { createBackend } from '../src/server/backend.js'
import { createOperations } from '../src/server/operations.js'
import { buildToolDefs, runTool } from '../src/server/tool-defs.js'
import { memoryProvider } from './memory-provider.js'

const validRange: ModelValidator = (input) =>
  Number(input['endsAt']) > Number(input['startsAt'])
    ? []
    : [{ path: 'endsAt', message: 'The end must be after the start.' }]
const ctx = { request: new Request('http://internal/') }
const valid = { startsAt: 10, endsAt: 20, ownerId: 1 }

function setup(options: ModelOptions = {}) {
  const config = defineBackend({
    access: { default: 'allow' },
    models: {
      event: model(
        {
          startsAt: t.number().required(),
          endsAt: t.number().required(),
          ownerId: t.number().required(),
        },
        {
          validate: validRange,
          ...options,
        },
      ),
    },
  })
  const data = memoryProvider(config)
  return { config, data, ops: createOperations(config, { data }) }
}

describe('model validation', () => {
  it('rejects a concurrent write that would invalidate a previously validated snapshot', async () => {
    let arrived = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const { data, ops } = setup({
      hooks: {
        beforeUpdate: async () => {
          if (++arrived === 2) release()
          await barrier
        },
      },
    })
    await ops.create(ctx, 'events', valid)
    const results = await Promise.all([
      ops.update(ctx, 'events', 1, { startsAt: 15 }),
      ops.update(ctx, 'events', 1, { endsAt: 12 }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toMatchObject({ code: 'conflict' })
    expect(validRange(data.rows('event')[0]!, null)).toEqual([])
  })
  it('returns HTTP 400 field issues without writing invalid input', async () => {
    const { config, data } = setup()
    const app = createBackend(config, { data })
    const response = await app.request('http://localhost/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...valid, endsAt: 5 }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      issues: [{ path: 'endsAt', message: 'The end must be after the start.' }],
    })
    expect(data.rows('event')).toHaveLength(0)
  })

  it('validates a partial update against the existing fields and retains the row on failure', async () => {
    const validate = vi.fn(validRange)
    const { data, ops } = setup({ validate })
    await ops.create(ctx, 'events', valid)
    const result = await ops.update(ctx, 'events', 1, { startsAt: 25 })
    expect(result).toMatchObject({ ok: false, code: 'validation', issues: [{ path: 'endsAt' }] })
    expect(validate).toHaveBeenLastCalledWith(
      expect.objectContaining({ startsAt: 25, endsAt: 20 }),
      expect.objectContaining({ startsAt: 10, endsAt: 20 }),
    )
    expect(data.rows('event')[0]).toMatchObject(valid)
    expect(await ops.update(ctx, 'events', 1, { endsAt: 30 })).toMatchObject({ ok: true })
  })

  it('keeps access-denied rows hidden and does not invoke the validator for them', async () => {
    const validate = vi.fn(validRange)
    const { ops } = setup({
      validate,
      access: { update: ({ where }) => where('ownerId', 'eq', 2) },
    })
    await ops.create(ctx, 'events', valid)
    validate.mockClear()
    expect(await ops.update(ctx, 'events', 1, { endsAt: 5 })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(validate).not.toHaveBeenCalled()
  })

  it('validates the final input after before-write hooks', async () => {
    const { data, ops } = setup({
      hooks: { beforeCreate: (_, input) => ({ ...input, endsAt: 0 }) },
    })
    expect(await ops.create(ctx, 'events', valid)).toMatchObject({ ok: false, code: 'validation' })
    expect(data.rows('event')).toHaveLength(0)
  })

  it('uses the same validator for generated agent tool writes', async () => {
    const { data, ops } = setup()
    const tool = buildToolDefs(ops.base).find((tool) => tool.name === 'events_create')!
    expect(await runTool(ops, ctx, tool, { ...valid, endsAt: 5 })).toMatchObject({
      ok: false,
      code: 'validation',
    })
    expect(data.rows('event')).toHaveLength(0)
  })

  it('supplies unchanged relation IDs in update validation input', async () => {
    const validate = vi.fn<ModelValidator>(() => [])
    const config = defineBackend({
      access: { default: 'allow' },
      models: {
        user: model({ name: t.text().required() }),
        note: model({ title: t.text().required(), author: t.relation('user') }, { validate }),
      },
    })
    const ops = createOperations(config, { data: memoryProvider(config) })
    await ops.create(ctx, 'users', { name: 'Ada' })
    await ops.create(ctx, 'notes', { title: 'Draft', authorId: 1 })
    await ops.update(ctx, 'notes', 1, { title: 'Published' })
    expect(validate).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Published', authorId: 1 }),
      expect.objectContaining({ title: 'Draft', authorId: 1 }),
    )
  })
})
