import { describe, expect, it } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { CloudConfigClientError, createClient, createTable } from '../src/client/index.js'
import { createBackend } from '../src/server/backend.js'
import { memoryProvider } from './memory-provider.js'

describe('client validation issues', () => {
  it('preserves field issues in mutationError independently of load errors', async () => {
    const config = defineBackend({
      access: { default: 'allow' },
      models: {
        event: model(
          { startsAt: t.number().required(), endsAt: t.number().required() },
          {
            validate: (input) =>
              Number(input['endsAt']) > Number(input['startsAt'])
                ? []
                : [{ path: 'endsAt', message: 'The end must be after the start.' }],
          },
        ),
      },
    })
    const app = createBackend(config, { data: memoryProvider(config) })
    const api = createClient<typeof config>({
      baseUrl: 'http://localhost/api',
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    })
    const table = createTable(api.event)
    await table.refresh()
    await expect(table.create({ startsAt: 10, endsAt: 5 })).rejects.toBeInstanceOf(
      CloudConfigClientError,
    )
    const error = table.state.mutationError
    if (!(error instanceof CloudConfigClientError)) {
      throw new Error('Expected a client validation error.')
    }
    expect(error.status).toBe(400)
    expect(error.issues).toEqual([{ path: 'endsAt', message: 'The end must be after the start.' }])
    expect(table.state.error).toBeNull()
    expect(table.state.result.data).toEqual([])
    table.dispose()
  })

  it('returns no field issues for error bodies without usable issues', () => {
    for (const body of [null, 'unavailable', {}, { issues: 'invalid' }]) {
      expect(new CloudConfigClientError('Failed', 500, body).issues).toEqual([])
    }
    const valid = { path: 'title', message: 'Required.' }
    const error = new CloudConfigClientError('Failed', 400, {
      issues: [null, {}, { path: 5, message: 'Wrong' }, valid],
    })
    expect(error.issues).toEqual([valid])
  })
})
