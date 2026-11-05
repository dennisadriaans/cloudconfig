import {
  createAgentRunner,
  createMemoryAgentRunStore,
  type AgentRunHost,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
} from './runs.js'
import {
  agentInstanceName,
  nextAgentSchedule,
  type AgentSchedule,
  type AgentScope,
} from './scheduling.js'

export {
  AgentApprovalRequired,
  defineAgentHost,
  type AgentRunHost,
  type AgentRunRequest,
  type AgentRunResult,
} from './runs.js'
export type { AgentSchedule, AgentScope } from './scheduling.js'

/** The runs of one owner, workspace, agent and session. */
export interface AgentRuns {
  start(request: AgentRunRequest): Promise<AgentRunResult>
  status(runId: string): Promise<AgentRunResult | null>
  /** Queue a run's continuation, for example after its approval was answered. */
  resume(runId: string): Promise<void>
}

/**
 * The port application code uses to run saved agents and keep their schedules.
 * The framework binds the adapter for the configured deployment target, so
 * callers never name a platform, binding or SDK.
 */
export interface AgentPlatform {
  runs(scope: AgentScope): Promise<AgentRuns>
  /** Replace, or cancel with null, the durable cron schedule stored under a stable key. */
  schedule(key: string, schedule: AgentSchedule | null): Promise<void>
}

export type AgentPlatformFactory = (env: Record<string, unknown> | undefined) => AgentPlatform

// A global symbol survives duplicate copies of this module in one process.
const REGISTRY = Symbol.for('cloudconfig.agentPlatform')
type Registry = { [REGISTRY]?: AgentPlatformFactory | undefined }

/** Bind the adapter once, from the framework's composition root; undefined unbinds it in tests. */
export function provideAgentPlatform(factory: AgentPlatformFactory | undefined): void {
  ;(globalThis as Registry)[REGISTRY] = factory
}

/**
 * The configured agent platform for this request's runtime bindings, or
 * undefined where no application declared agents, such as the CLI.
 */
export function getAgentPlatform(env?: Record<string, unknown>): AgentPlatform | undefined {
  return (globalThis as Registry)[REGISTRY]?.(env)
}

/** Adapters accept runs only for the scope they were opened with. */
export function assertRunScope(request: AgentRunRequest, scope: AgentScope): void {
  if (
    (['ownerId', 'workspace', 'agentId', 'sessionId'] as const).some(
      (key) => request.scope?.[key] !== scope[key],
    )
  ) {
    throw new Error('A run belongs to the owner, workspace, agent and session it was opened for.')
  }
}

const MODEL_CALL_TIMEOUT_MS = 120_000
const MAX_TIMER_MS = 2_147_483_647

export interface MemoryAgentPlatformOptions<Env> {
  env?: Env
  timeoutMs?: number
  /** Background run and schedule failures; defaults to console.error. */
  onError?: (cause: unknown) => void
}

/**
 * Development and test adapter. Runs and schedules live in this process and
 * end with it; dispatch continues a run in the background of the same process.
 */
export function createMemoryAgentPlatform<Env = undefined>(
  host: AgentRunHost<Env>,
  options: MemoryAgentPlatformOptions<Env> = {},
): AgentPlatform {
  const env = options.env as Env
  const report = options.onError ?? ((cause) => console.error('[cloudconfig] agents:', cause))
  const runners = new Map<string, AgentRunner>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function runnerFor(name: string): AgentRunner {
    const existing = runners.get(name)
    if (existing) return existing
    const runner: AgentRunner = createAgentRunner({
      host,
      env,
      store: createMemoryAgentRunStore(),
      timeoutMs: options.timeoutMs ?? MODEL_CALL_TIMEOUT_MS,
      dispatch: (runId) => void runner.resume(runId).catch(report),
    })
    runners.set(name, runner)
    return runner
  }

  function arm(key: string, value: AgentSchedule, dueAt: Date) {
    const timer = setTimeout(
      () => {
        if (timers.get(key) !== timer) return
        // Timers cap at about 24.8 days; wait again until the cron time is due.
        if (Date.now() < dueAt.getTime()) return arm(key, value, dueAt)
        const after = new Date(Math.max(Date.now(), dueAt.getTime()))
        arm(key, value, nextAgentSchedule(value.cron, value.timeZone, after))
        void Promise.resolve()
          .then(() => host.scheduled?.(value.payload, dueAt.toISOString(), env))
          .catch(report)
      },
      Math.min(Math.max(dueAt.getTime() - Date.now(), 0), MAX_TIMER_MS),
    )
    // Development schedules never keep a process alive.
    ;(timer as { unref?: () => void }).unref?.()
    timers.set(key, timer)
  }

  return {
    async runs(scope) {
      const runner = runnerFor(await agentInstanceName(scope))
      return {
        start: async (request) => {
          assertRunScope(request, scope)
          return runner.start(request)
        },
        status: (runId) => runner.status(runId),
        resume: async (runId) => void runner.resume(runId).catch(report),
      }
    },
    async schedule(key, value) {
      if (value && !host.scheduled) {
        throw new Error('The agent host must implement scheduled() before scheduling runs.')
      }
      const due = value ? nextAgentSchedule(value.cron, value.timeZone) : null
      const previous = timers.get(key)
      if (previous !== undefined) clearTimeout(previous)
      timers.delete(key)
      if (value && due) arm(key, value, due)
    },
  }
}
