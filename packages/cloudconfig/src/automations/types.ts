export interface AutomationScope {
  /** null denotes a trusted workspace/system job, never an anonymous browser request. */
  ownerId: number | null
  workspace: string
}

export interface AutomationRun extends AutomationIdentity {
  task: string
  payload: unknown
}

export interface AutomationIdentity {
  scope: AutomationScope
  runId: string
}

export interface AutomationResult {
  runId: string
  status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  output: unknown
  error: string
  wakeAt?: string
  waitingFor?: string
}

export interface AutomationStepOptions {
  /** Retry only operations which are safe to repeat with the same idempotency key. */
  idempotent?: boolean
  attempts?: number
  retryDelayMs?: number
}

export interface AutomationAction {
  idempotencyKey: string
  signal: AbortSignal
  attempt: number
}

export interface AutomationContext<Env> {
  env: Env
  scope: AutomationScope
  runId: string
  signal: AbortSignal
  /** Stable, unique names identify checkpoints across retries and process restarts. */
  step<T>(
    name: string,
    action: (context: AutomationAction) => Promise<T>,
    options?: AutomationStepOptions,
  ): Promise<T>
  sleep(name: string, milliseconds: number): Promise<void>
  waitForEvent<T = unknown>(name: string): Promise<T>
}

export interface AutomationHost<Env = Record<string, unknown> | undefined> {
  /** Recheck task ownership and current permissions at acceptance and every continuation. */
  authorize(request: AutomationRun, context: { env: Env; signal: AbortSignal }): Promise<void>
  tasks: Record<string, (payload: unknown, context: AutomationContext<Env>) => Promise<unknown>>
}

export function defineAutomationHost<Env = Record<string, unknown> | undefined>(
  host: AutomationHost<Env>,
): AutomationHost<Env> {
  return host
}

export interface AutomationSchedule {
  cron: string
  timeZone: string
  run: Omit<AutomationRun, 'runId'>
}

export interface AutomationRuns {
  start(request: AutomationRun): Promise<AutomationResult>
  status(runId: string): Promise<AutomationResult | null>
  resume(runId: string): Promise<void>
  signal(runId: string, event: string, payload: unknown): Promise<void>
  cancel(runId: string): Promise<void>
}

export interface AutomationPlatform {
  runs(scope: AutomationScope): Promise<AutomationRuns>
  schedule(key: string, value: AutomationSchedule | null): Promise<void>
  /** Synchronize only declared static schedules; runtime schedules keep their own namespace. */
  configure(schedules: Record<string, AutomationSchedule>): Promise<void>
}

export function isAutomationTerminal(result: AutomationResult): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(result.status)
}
