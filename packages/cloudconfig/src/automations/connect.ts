import type { AnyConfig } from '../dsl/model-config.js'
import { configuredDatabase } from '../drivers/configured.js'
import { compileConfig } from '../server/compile/index.js'
import { createConnect } from '../connect/runtime.js'
import { CONNECT_MAINTENANCE_TASK } from '../shared/automation-config.js'
import { databaseExecutionRecords } from '../durable/database-records.js'
import { readDurableRecord, withDurableLease, writeDurableRecord } from '../durable/records.js'
import type { AutomationHost } from './types.js'

/** Add system housekeeping without granting the application's tasks system privileges. */
export function withConnectAutomations<Env extends Record<string, unknown> | undefined>(
  host: AutomationHost<Env>,
  config: AnyConfig,
): AutomationHost<Env> {
  if (!config.connect) return host
  if (Object.hasOwn(host.tasks, CONNECT_MAINTENANCE_TASK)) {
    throw new Error(`${CONNECT_MAINTENANCE_TASK} is a reserved system task.`)
  }
  const base = compileConfig(config)
  const provider = configuredDatabase(config)
  return {
    async authorize(request, context) {
      if (request.task !== CONNECT_MAINTENANCE_TASK) return host.authorize(request, context)
      if (request.scope.ownerId !== null || request.scope.workspace !== 'cloudconfig:system') {
        throw new Error('Connect maintenance is a system task.')
      }
    },
    tasks: {
      ...host.tasks,
      async [CONNECT_MAINTENANCE_TASK](payload, context) {
        const limit =
          payload && typeof payload === 'object' && 'limit' in payload ? payload.limit : 50
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) {
          throw new Error('Connect maintenance limit must be between 1 and 500.')
        }
        const totals = { refreshed: 0, failed: 0, resealed: 0, removed: 0 }
        for (let offset = 0; offset < limit; offset += 5) {
          const batch = await context.step(
            `maintain-batch:${offset}`,
            async () => {
              const records = databaseExecutionRecords(config, context.env)
              const cursorKey = 'cloudconfig:connect:maintenance-cursor'
              return withDurableLease(records, cursorKey, async (assertOwner) => {
                const cursor = await readDurableRecord<{ afterId: number; afterClientId?: number }>(
                  records,
                  cursorKey,
                )
                const db = await provider.connect({
                  env: context.env,
                  request: new Request('https://cloudconfig.internal/connect-maintenance'),
                })
                const connect = createConnect(base, {
                  db,
                  env: context.env,
                  fetch: (input, init) =>
                    fetch(input, {
                      ...init,
                      signal: AbortSignal.any([
                        context.signal,
                        ...(init?.signal ? [init.signal] : []),
                      ]),
                    }),
                })
                const result = await connect.maintain({
                  limit: Math.min(5, limit - offset),
                  afterId: cursor?.afterId ?? 0,
                  afterClientId: cursor?.afterClientId ?? 0,
                  signal: context.signal,
                })
                await assertOwner()
                await writeDurableRecord(records, cursorKey, () => ({
                  afterId: result.nextCursor ?? 0,
                  afterClientId: result.nextClientCursor ?? 0,
                }))
                return result
              })
            },
            { idempotent: true, attempts: 3 },
          )
          if (!batch) break
          totals.refreshed += batch.refreshed
          totals.failed += batch.failed
          totals.resealed += batch.resealed
          totals.removed += batch.removed
          if (batch.nextCursor === null && batch.nextClientCursor === null) break
        }
        return totals
      },
    },
  }
}
