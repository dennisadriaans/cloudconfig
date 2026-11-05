import { runSavedAgent, type AgentInvocation, type AgentToolCall } from './runtime.js'
import { agentInstanceName, type AgentScope } from './scheduling.js'

export interface AgentRunRequest {
  runId: string
  scope: AgentScope
  payload: unknown
  instructions: string
  /** Host context set by the trusted gateway, never by a client. Stored with the run. */
  context?: Record<string, unknown>
}
export interface AgentRunResult {
  runId: string
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed'
  output: string
  error: string
  approvalId?: number
}
export type ResolvedAgentInvocation = Omit<
  AgentInvocation,
  'payload' | 'instructions' | 'signal' | 'checkpoint' | 'runId'
>

/**
 * Supplied by the application. `resolve` loads the saved agent, provider keys
 * and currently granted tools for the authenticated scope; it runs again on
 * every resume so revoked permissions apply to the rest of the run.
 */
export interface AgentRunHost<Env> {
  resolve(request: AgentRunRequest, env: Env): Promise<ResolvedAgentInvocation>
  /** Return the approved action's actual result, or an approval-required value while pending. */
  approval?(request: AgentRunRequest, approvalId: number, env: Env): Promise<unknown>
  /** Platform schedulers call this when a stored cron schedule is due. */
  scheduled?(payload: Record<string, unknown>, dueAt: string, env: Env): Promise<void>
  /** Replace the provider harness for a run, for example with a local CLI in development. */
  execute?(invocation: AgentInvocation, request: AgentRunRequest): Promise<string>
}

/**
 * Declare how saved agents run in this application. The same host serves every
 * deployment target; the framework creates the platform's agent from it.
 */
export function defineAgentHost<Env = Record<string, unknown> | undefined>(
  host: AgentRunHost<Env>,
): AgentRunHost<Env> {
  return host
}

export class AgentApprovalRequired extends Error {
  constructor(readonly approvalId: number) {
    super('The owner must approve this action in Integrations.')
    this.name = 'AgentApprovalRequired'
  }
}

export interface StoredAgentRun {
  request: AgentRunRequest
  /** The definition and tools accepted at start; a run never switches definitions. */
  snapshot: Pick<AgentInvocation, 'agent' | 'tools'>
  result: AgentRunResult
}
export type AgentReceipt =
  | { status: 'started' }
  | { status: 'approval'; approvalId: number }
  | { status: 'completed'; value: unknown }

/**
 * Durable state for one scope's runs. Implement it on any store with
 * read-your-writes consistency: Durable Object SQLite, D1, DynamoDB, Cosmos DB.
 */
export interface AgentRunStore {
  run(runId: string): Promise<StoredAgentRun | null>
  /** Insert unless the run exists; a run ID is an idempotency key. */
  insert(run: StoredAgentRun): Promise<void>
  update(result: AgentRunResult): Promise<void>
  receipt(runId: string, name: string): Promise<AgentReceipt | null>
  setReceipt(runId: string, name: string, receipt: AgentReceipt): Promise<void>
}

export interface AgentRunnerOptions<Env> {
  host: AgentRunHost<Env>
  store: AgentRunStore
  env: Env
  /** Continue a run outside the accepting request: an alarm, queue message or waitUntil. */
  dispatch(runId: string): Promise<void> | void
  /** Fresh deadline per model call. */
  timeoutMs?: number
  /** Bound new model/tool calls per durable activity; completed receipts replay without consuming this budget. */
  maxSteps?: number
  /** Deadline for this execution segment, rather than the lifetime of a durable run. */
  signal?: AbortSignal
}

export interface AgentRunner {
  start(request: AgentRunRequest): Promise<AgentRunResult>
  status(runId: string): Promise<AgentRunResult | null>
  /** Execute or continue a run. Concurrent calls for one run in this process are ignored. */
  resume(runId: string): Promise<void>
}

const RUN_ID = /^[a-zA-Z0-9_-]{1,100}$/

/**
 * Platform-neutral durable run state machine. Model rounds and tool results are
 * receipts, so a resumed run replays them instead of repeating provider or
 * external calls. A crash between dispatching a tool and saving its result is
 * ambiguous; that run fails for review rather than repeating an external write.
 */
export function createAgentRunner<Env>(options: AgentRunnerOptions<Env>): AgentRunner {
  const { host, store, env } = options
  const active = new Set<string>()
  const steps = new Map<string, number>()

  function consumeStep(runId: string): void {
    const used = steps.get(runId) ?? 0
    if (options.maxSteps !== undefined && used >= options.maxSteps) throw new AgentRunYield()
    options.signal?.throwIfAborted()
    steps.set(runId, used + 1)
  }

  async function checkpoint<T>(runId: string, name: string, callback: () => Promise<T>) {
    const receipt = await store.receipt(runId, name)
    if (receipt?.status === 'completed') return receipt.value as T
    consumeStep(runId)
    const value = await callback()
    await store.setReceipt(runId, name, { status: 'completed', value })
    return value
  }

  async function callTool(
    { request, resolved }: { request: AgentRunRequest; resolved: ResolvedAgentInvocation },
    name: string,
    input: Record<string, unknown>,
    call: AgentToolCall,
  ) {
    const runId = request.runId
    const key = `tool ${call.callId}`
    const receipt = await store.receipt(runId, key)
    if (receipt?.status === 'completed') return receipt.value
    if (receipt?.status === 'approval') {
      if (!host.approval) throw new AgentApprovalRequired(receipt.approvalId)
      consumeStep(runId)
      const value = await host.approval(request, receipt.approvalId, env)
      if (isApproval(value)) throw new AgentApprovalRequired(receipt.approvalId)
      await store.setReceipt(runId, key, { status: 'completed', value })
      return value
    }
    if (receipt) {
      throw new Error(
        'A tool call was interrupted after dispatch. Check its external result before retrying in a new run.',
      )
    }
    if (!resolved.tools.some((tool) => tool.name === name)) {
      throw new Error('This tool is no longer granted to the agent.')
    }
    consumeStep(runId)
    await store.setReceipt(runId, key, { status: 'started' })
    const value = await resolved.callTool(name, input, call)
    if (isApproval(value)) {
      await store.setReceipt(runId, key, { status: 'approval', approvalId: value.approvalId })
      throw new AgentApprovalRequired(value.approvalId)
    }
    await store.setReceipt(runId, key, { status: 'completed', value })
    return value
  }

  async function execute({ request, snapshot, result }: StoredAgentRun) {
    const { approvalId: _previous, ...rest } = result
    let next: AgentRunResult = { ...rest, status: 'running' }
    await store.update(next)
    try {
      const resolved = await host.resolve(request, env)
      const invocation: AgentInvocation = {
        ...resolved,
        ...snapshot,
        runId: `${await agentInstanceName(request.scope)}-${request.runId}`,
        instructions: request.instructions,
        payload: request.payload,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        checkpoint: (name, callback) => checkpoint(request.runId, name, callback),
        callTool: (name, input, call) => callTool({ request, resolved }, name, input, call),
      }
      const output = host.execute
        ? await host.execute(invocation, request)
        : await runSavedAgent(invocation)
      next = { ...next, status: 'succeeded', output, error: '' }
    } catch (cause) {
      const waiting = cause instanceof AgentApprovalRequired
      const yielded = cause instanceof AgentRunYield
      let status: AgentRunResult['status'] = 'failed'
      let error = cause instanceof Error ? cause.message : 'Agent execution failed.'
      if (yielded) {
        status = 'queued'
        error = ''
      } else if (waiting) {
        status = 'waiting'
      }
      next = {
        ...next,
        status,
        error,
        ...(waiting ? { approvalId: cause.approvalId } : {}),
      }
    }
    await store.update(next)
  }

  return {
    async start(request) {
      if (typeof request.runId !== 'string' || !RUN_ID.test(request.runId)) {
        throw new Error('Use a valid run ID.')
      }
      const existing = await store.run(request.runId)
      if (existing) return existing.result
      // Resolving checks ownership and tool permissions before accepting the run.
      const { agent, tools } = await host.resolve(request, env)
      await store.insert({
        request,
        snapshot: { agent, tools },
        result: { runId: request.runId, status: 'queued', output: '', error: '' },
      })
      await options.dispatch(request.runId)
      return (await store.run(request.runId))!.result
    },
    async status(runId) {
      return (await store.run(runId))?.result ?? null
    },
    async resume(runId) {
      if (active.has(runId)) return
      active.add(runId)
      steps.set(runId, 0)
      try {
        const run = await store.run(runId)
        if (run && run.result.status !== 'succeeded' && run.result.status !== 'failed') {
          await execute(run)
        }
      } finally {
        active.delete(runId)
        steps.delete(runId)
      }
    },
  }
}

class AgentRunYield extends Error {}

/** Process-local store for development and tests. Runs are lost on restart. */
export function createMemoryAgentRunStore(): AgentRunStore {
  const runs = new Map<string, StoredAgentRun>()
  const receipts = new Map<string, AgentReceipt>()
  return {
    async run(runId) {
      const run = runs.get(runId)
      return run ? structuredClone(run) : null
    },
    async insert(run) {
      if (!runs.has(run.request.runId)) runs.set(run.request.runId, structuredClone(run))
    },
    async update(result) {
      const run = runs.get(result.runId)
      if (run) run.result = structuredClone(result)
    },
    async receipt(runId, name) {
      return receipts.get(`${runId}\n${name}`) ?? null
    },
    async setReceipt(runId, name, receipt) {
      receipts.set(`${runId}\n${name}`, receipt)
    },
  }
}

export function isApproval(
  value: unknown,
): value is { approvalRequired: true; approvalId: number } {
  return (
    !!value &&
    typeof value === 'object' &&
    'approvalRequired' in value &&
    value.approvalRequired === true &&
    'approvalId' in value &&
    typeof value.approvalId === 'number'
  )
}
