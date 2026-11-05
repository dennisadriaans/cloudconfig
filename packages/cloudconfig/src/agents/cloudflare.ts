/// <reference types="@cloudflare/workers-types" />
import { Agent } from 'agents'
import {
  createAgentRunner,
  type AgentReceipt,
  type AgentRunHost,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunStore,
  type AgentRunner,
  type StoredAgentRun,
} from './runs.js'
import { nextAgentSchedule, type AgentSchedule } from './scheduling.js'
import type { CloudflareAgentRpc } from './cloudflare-client.js'

export {
  AgentApprovalRequired,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunHost,
} from './runs.js'
export type { CloudflareAgentRpc } from './cloudflare-client.js'

type Sql = Agent<Record<string, unknown>>['sql']
type ScheduleRecord = AgentSchedule & { generation: string; dueAt: string; alarmId?: string }

const MODEL_CALL_TIMEOUT_MS = 120_000

/** The run store on the Agent's own SQLite storage. Table layout is stable across releases. */
export function sqliteAgentRunStore(sql: Sql): AgentRunStore {
  void sql`CREATE TABLE IF NOT EXISTS cc_runs (id TEXT PRIMARY KEY, request TEXT NOT NULL, snapshot TEXT NOT NULL, result TEXT NOT NULL)`
  void sql`CREATE TABLE IF NOT EXISTS cc_receipts (run TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run,name))`
  return {
    async run(runId) {
      const row = sql<{ request: string; snapshot: string; result: string }>`
        SELECT request, snapshot, result FROM cc_runs WHERE id = ${runId}`[0]
      return row
        ? {
            request: JSON.parse(row.request) as StoredAgentRun['request'],
            snapshot: JSON.parse(row.snapshot) as StoredAgentRun['snapshot'],
            result: JSON.parse(row.result) as AgentRunResult,
          }
        : null
    },
    async insert({ request, snapshot, result }) {
      void sql`INSERT OR IGNORE INTO cc_runs VALUES (${request.runId}, ${JSON.stringify(request)}, ${JSON.stringify(snapshot)}, ${JSON.stringify(result)})`
    },
    async update(result) {
      void sql`UPDATE cc_runs SET result = ${JSON.stringify(result)} WHERE id = ${result.runId}`
    },
    async receipt(runId, name) {
      const row = sql<{ status: string; value: string }>`
        SELECT status, value FROM cc_receipts WHERE run = ${runId} AND name = ${name}`[0]
      if (!row) return null
      if (row.status === 'approval') return { status: 'approval', approvalId: Number(row.value) }
      if (row.status === 'completed') return { status: 'completed', value: JSON.parse(row.value) }
      return { status: 'started' }
    },
    async setReceipt(runId, name, receipt: AgentReceipt) {
      const value = encodeReceiptValue(receipt)
      void sql`INSERT OR REPLACE INTO cc_receipts VALUES (${runId}, ${name}, ${receipt.status}, ${value})`
    },
  }
}

/**
 * Official Cloudflare Agent around the portable run state machine. One
 * instance holds one owner/workspace/agent/session scope, or one schedule.
 * Frameworks generate this class from the application's host; callers reach
 * it through `cloudflareAgentPlatform`, never through public Agent routing.
 * Provider keys stay in env.
 */
export function createCloudflareAgent<Env extends Record<string, unknown>>(
  host: AgentRunHost<Env>,
): new (...args: ConstructorParameters<typeof Agent<Env>>) => Agent<Env> & CloudflareAgentRpc {
  return class CloudconfigAgent extends Agent<Env> {
    private runner?: AgentRunner
    private activeScheduleTicks = new Set<string>()

    /** Lazily creates the run tables, so RPC never depends on onStart ordering. */
    private runs(): AgentRunner {
      return (this.runner ??= createAgentRunner({
        host,
        store: sqliteAgentRunStore(this.sql.bind(this)),
        env: this.env,
        timeoutMs: MODEL_CALL_TIMEOUT_MS,
        dispatch: async (runId) => {
          await this.schedule(0, 'resumeRun', { runId }, { idempotent: true })
        },
      }))
    }

    async onStart() {
      this.runs()
      void this
        .sql`CREATE TABLE IF NOT EXISTS cc_schedule (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`
      // Agent alarms survive eviction; this also recovers a run interrupted between alarms.
      for (const row of this.sql<{ id: string }>`
        SELECT id FROM cc_runs WHERE json_extract(result, '$.status') IN ('queued', 'running')`) {
        await this.schedule(0, 'resumeRun', { runId: row.id }, { idempotent: true })
      }
      const schedule = readSchedule(this.sql.bind(this))
      if (schedule) await this.armSchedule(schedule)
    }

    async start(request: AgentRunRequest): Promise<AgentRunResult> {
      const runner = this.runs()
      const first = this.sql<{ request: string }>`SELECT request FROM cc_runs LIMIT 1`[0]
      if (
        first &&
        (['ownerId', 'workspace', 'agentId', 'sessionId'] as const).some(
          (key) => (JSON.parse(first.request) as AgentRunRequest).scope[key] !== request.scope[key],
        )
      ) {
        throw new Error('An Agent instance belongs to one owner, workspace, agent and session.')
      }
      return runner.start(request)
    }

    async status(runId: string): Promise<AgentRunResult | null> {
      return this.runs().status(runId)
    }

    async resumeRun({ runId }: { runId: string }) {
      await this.keepAliveWhile(() => this.runs().resume(runId))
    }

    async continueRun({ runId }: { runId: string }) {
      await this.schedule(0, 'resumeRun', { runId }, { idempotent: true })
    }

    async setSchedule(value: AgentSchedule | null): Promise<void> {
      if (value && !host.scheduled) {
        throw new Error('The agent host must implement scheduled() before scheduling runs.')
      }
      void this
        .sql`CREATE TABLE IF NOT EXISTS cc_schedule (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`
      const due = value ? nextAgentSchedule(value.cron, value.timeZone) : null
      const old = readSchedule(this.sql.bind(this))
      const record: ScheduleRecord | null =
        value && due
          ? { ...value, generation: crypto.randomUUID(), dueAt: due.toISOString() }
          : null
      // Commit intent before alarm I/O; onStart recovers an interrupted registration.
      if (record) {
        void this.sql`INSERT OR REPLACE INTO cc_schedule VALUES (1, ${JSON.stringify(record)})`
      } else void this.sql`DELETE FROM cc_schedule WHERE id = 1`
      if (old?.alarmId) await this.cancelSchedule(old.alarmId)
      if (record) await this.armSchedule(record)
    }

    private async armSchedule(record: ScheduleRecord): Promise<void> {
      const current = readSchedule(this.sql.bind(this))
      if (current?.generation !== record.generation || current.dueAt !== record.dueAt) return
      const alarm = await this.schedule(
        new Date(record.dueAt),
        'fireSchedule',
        { generation: record.generation, dueAt: record.dueAt },
        { idempotent: true },
      )
      const latest = readSchedule(this.sql.bind(this))
      if (latest?.generation !== record.generation || latest.dueAt !== record.dueAt) {
        await this.cancelSchedule(alarm.id)
        return
      }
      void this
        .sql`UPDATE cc_schedule SET value = ${JSON.stringify({ ...latest, alarmId: alarm.id })} WHERE id = 1`
    }

    async fireSchedule({ generation, dueAt }: { generation: string; dueAt: string }) {
      const tick = `${generation}:${dueAt}`
      if (this.activeScheduleTicks.has(tick)) return
      this.activeScheduleTicks.add(tick)
      try {
        await this.keepAliveWhile(() => this.fireCurrentSchedule({ generation, dueAt }))
      } finally {
        this.activeScheduleTicks.delete(tick)
      }
    }

    private async fireCurrentSchedule({
      generation,
      dueAt,
    }: {
      generation: string
      dueAt: string
    }) {
      const current = readSchedule(this.sql.bind(this))
      if (!current || current.generation !== generation || current.dueAt !== dueAt) return
      if (!host.scheduled) {
        throw new Error('The agent host must implement scheduled() before executing schedules.')
      }
      const store = sqliteAgentRunStore(this.sql.bind(this))
      const receipt = await store.receipt(`schedule:${generation}`, dueAt)
      if (receipt && receipt.status !== 'completed') {
        throw new Error(
          'A scheduled action was interrupted. Review its external result before enabling the schedule again.',
        )
      }
      if (!receipt) {
        await store.setReceipt(`schedule:${generation}`, dueAt, { status: 'started' })
        await host.scheduled(current.payload, dueAt, this.env)
        await store.setReceipt(`schedule:${generation}`, dueAt, {
          status: 'completed',
          value: null,
        })
      }
      const latest = readSchedule(this.sql.bind(this))
      if (latest?.generation !== generation || latest.dueAt !== dueAt) return
      // The host rechecks active status and ownership. A stable dueAt deduplicates alarm retries.
      const next = nextAgentSchedule(
        current.cron,
        current.timeZone,
        new Date(Math.max(Date.now(), new Date(dueAt).getTime())),
      )
      const { alarmId: _previousAlarm, ...previous } = current
      const record: ScheduleRecord = { ...previous, dueAt: next.toISOString() }
      void this.sql`UPDATE cc_schedule SET value = ${JSON.stringify(record)} WHERE id = 1`
      await this.armSchedule(record)
    }
  }
}

function readSchedule(sql: Sql): ScheduleRecord | null {
  const row = sql<{ value: string }>`SELECT value FROM cc_schedule WHERE id = 1`[0]
  return row ? (JSON.parse(row.value) as ScheduleRecord) : null
}

/** Receipts share one text column: the approval id, the JSON result, or nothing yet. */
function encodeReceiptValue(receipt: AgentReceipt): string {
  if (receipt.status === 'approval') return String(receipt.approvalId)
  if (receipt.status === 'completed') return JSON.stringify(receipt.value ?? null)
  return ''
}
