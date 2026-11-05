/// <reference types="@cloudflare/workers-types" />
import { Agent } from 'agents'
import type { DurableRecordStore } from '../durable/records.js'
import { cloudflareAutomationPlatform, type CloudflareAutomationRpc } from './cloudflare-client.js'
import { provideAutomationPlatform } from './platform.js'
import {
  automationService,
  type AutomationScheduleIdentity,
  type AutomationScheduleTick,
  type StoredAutomationSchedule,
} from './service.js'
import type { StoredAutomation } from './runtime.js'
import {
  isAutomationTerminal,
  type AutomationHost,
  type AutomationIdentity,
  type AutomationResult,
  type AutomationRun,
  type AutomationSchedule,
} from './types.js'

/** SQLite-backed native jobs. Runs and schedules use separate named Durable Object instances. */
export function createCloudflareAutomations<Env extends Record<string, unknown>>(
  host: AutomationHost<Env>,
  options: { binding: string },
): new (...args: ConstructorParameters<typeof Agent<Env>>) => Agent<Env> & CloudflareAutomationRpc {
  provideAutomationPlatform((env) => cloudflareAutomationPlatform(env?.[options.binding]))
  return class CloudconfigAutomations extends Agent<Env> {
    private execution?: ReturnType<typeof automationService<Env>>

    private service(): ReturnType<typeof automationService<Env>> {
      if (this.execution) return this.execution
      void this
        .sql`CREATE TABLE IF NOT EXISTS cc_automation_records (key TEXT PRIMARY KEY, value TEXT NOT NULL, version TEXT NOT NULL)`
      const records: DurableRecordStore = {
        read: async (key) =>
          this.sql<{
            value: string
            version: string
          }>`SELECT value, version FROM cc_automation_records WHERE key = ${key}`[0] ?? null,
        create: async (key, value) =>
          this
            .sql`INSERT OR IGNORE INTO cc_automation_records VALUES (${key}, ${value}, ${crypto.randomUUID()}) RETURNING key`
            .length === 1,
        replace: async (key, value, version) =>
          this
            .sql`UPDATE cc_automation_records SET value = ${value}, version = ${crypto.randomUUID()} WHERE key = ${key} AND version = ${version} RETURNING key`
            .length === 1,
      }
      this.execution = automationService({
        host,
        env: this.env,
        records,
        enqueue: async (request) =>
          (await cloudflareAutomationPlatform(this.env[options.binding]).runs(request.scope)).start(
            request,
          ),
        dispatcher: {
          startRun: (input) => this.armRun(input),
          startSchedule: (input) => this.armSchedule(input),
          isActive: async (id) => !!(await this.getScheduleById(id)),
          wake: async (id) => {
            const current = await this.getScheduleById(id)
            if (!current) return
            await this.cancelSchedule(id)
            await this.armRun(current.payload as AutomationIdentity, { shouldWake: true })
          },
          cancel: async (id) => {
            await this.cancelSchedule(id)
          },
        },
      })
      return this.execution
    }

    async onStart() {
      const service = this.service()
      const rows = this.sql<{
        value: string
      }>`SELECT value FROM cc_automation_records WHERE json_extract(value, '$.kind') IN ('automation-run', 'automation-schedule')`
      for (const row of rows) {
        const record = JSON.parse(row.value) as StoredAutomation | StoredAutomationSchedule
        if (record.kind === 'automation-run') {
          if (
            !isAutomationTerminal(record.result) &&
            (record.result.status !== 'waiting' || record.result.wakeAt)
          ) {
            await this.armRun({ scope: record.request.scope, runId: record.request.runId })
          }
        } else if (record.value && record.dueAt) {
          const id = await this.armSchedule(record)
          await service.trackSchedule(record, id, record.dueAt)
        }
      }
    }

    async start(request: AutomationRun): Promise<AutomationResult> {
      this.service()
      const row = this.sql<{
        value: string
      }>`SELECT value FROM cc_automation_records WHERE json_extract(value, '$.kind') = 'automation-run' LIMIT 1`[0]
      if (row) {
        const first = (JSON.parse(row.value) as StoredAutomation).request.scope
        if (
          first.ownerId !== request.scope.ownerId ||
          first.workspace !== request.scope.workspace
        ) {
          throw new Error('An automation instance belongs to one owner and workspace.')
        }
      }
      return (await this.service().platform.runs(request.scope)).start(request)
    }
    async status(input: AutomationIdentity) {
      return this.service().runtime.status(input)
    }
    async resume(input: AutomationIdentity) {
      await (await this.service().platform.runs(input.scope)).resume(input.runId)
    }
    async signal(input: AutomationIdentity & { event: string; payload: unknown }) {
      await (
        await this.service().platform.runs(input.scope)
      ).signal(input.runId, input.event, input.payload)
    }
    async cancel(input: AutomationIdentity) {
      await (await this.service().platform.runs(input.scope)).cancel(input.runId)
    }
    async setSchedule(input: { key: string; value: AutomationSchedule | null }) {
      await this.service().platform.schedule(input.key, input.value)
    }
    async configure(schedules: Record<string, AutomationSchedule>) {
      await this.service().platform.configure(schedules)
    }

    private async armRun(
      input: AutomationIdentity,
      options: { shouldWake?: boolean } = {},
    ): Promise<string> {
      const { result, revision } = await this.service().runtime.continuation(input)
      const dueAt = !options.shouldWake && result.wakeAt ? new Date(result.wakeAt) : 0
      const payload = { scope: input.scope, runId: input.runId, revision }
      return (await this.schedule(dueAt, 'tick', payload, { idempotent: true })).id
    }
    async tick(input: AutomationIdentity & { revision: number }) {
      await this.keepAliveWhile(async () => {
        if ((await this.service().runtime.continuation(input)).revision !== input.revision) return
        const result = await this.service().runtime.tick(input)
        if (!isAutomationTerminal(result) && (result.status !== 'waiting' || result.wakeAt)) {
          await this.armRun(input)
        }
      })
    }
    private async armSchedule(input: AutomationScheduleIdentity): Promise<string> {
      const current = await this.service().schedule(input)
      if (!current?.dueAt) throw new Error('The automation schedule was replaced or cancelled.')
      return (
        await this.schedule(
          new Date(current.dueAt),
          'fireSchedule',
          { key: input.key, generation: input.generation, dueAt: current.dueAt },
          { idempotent: true },
        )
      ).id
    }
    async fireSchedule(input: AutomationScheduleTick) {
      await this.keepAliveWhile(async () => {
        await this.service().fire(input)
        const next = await this.service().schedule(input)
        if (!next?.dueAt) return
        const id = await this.armSchedule(next)
        await this.service().trackSchedule(next, id, next.dueAt)
      })
    }
  }
}
