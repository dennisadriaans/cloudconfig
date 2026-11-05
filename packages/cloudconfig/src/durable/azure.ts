import { app } from '@azure/functions'
import * as df from 'durable-functions'
import type { AgentRunHost, AgentRunRequest, AgentRunResult } from '../agents/runs.js'
import type { AgentScope, AgentSchedule } from '../agents/scheduling.js'
import {
  createDurableAgentPlatform,
  durableAgentRuntime,
  type DurableSchedule,
  type NativeAgentRun,
  type NativeAgentSchedule,
  type NativeAgentScheduleTick,
} from '../agents/durable.js'
import { azureExecutionRecords } from './azure-records.js'
import { provideAgentPlatform, type AgentPlatform } from '../agents/platform.js'
import { provideAutomationPlatform } from '../automations/platform.js'
import {
  automationService,
  type AutomationScheduleIdentity,
  type AutomationScheduleTick,
  type StoredAutomationSchedule,
} from '../automations/service.js'
import {
  isAutomationTerminal,
  type AutomationHost,
  type AutomationIdentity,
  type AutomationResult,
} from '../automations/types.js'
import {
  executeAutomationCommand,
  readDurableCommand,
  type DurableCommand,
} from '../automations/commands.js'

const RUN = 'cloudconfigAgentRun'
const TICK = 'cloudconfigAgentTick'
const SCHEDULE = 'cloudconfigAgentSchedule'
const NEXT = 'cloudconfigAgentNextSchedule'
const FIRE = 'cloudconfigAgentFireSchedule'
const AUTOMATION_RUN = 'cloudconfigAutomationRun'
const AUTOMATION_TICK = 'cloudconfigAutomationTick'
const AUTOMATION_SCHEDULE = 'cloudconfigAutomationSchedule'
const AUTOMATION_NEXT = 'cloudconfigAutomationNextSchedule'
const AUTOMATION_FIRE = 'cloudconfigAutomationFireSchedule'

export interface AgentOrchestrationContext {
  df: Pick<
    df.DurableOrchestrationContext,
    | 'getInput'
    | 'callActivityWithRetry'
    | 'setCustomStatus'
    | 'waitForExternalEvent'
    | 'createTimer'
    | 'continueAsNew'
    | 'currentUtcDateTime'
  >
}

/** The orchestration itself only uses replay-safe Durable Functions operations. */
export function* azureAgentRun(context: AgentOrchestrationContext) {
  const input: NativeAgentRun = context.df.getInput()
  for (;;) {
    const result: AgentRunResult = yield context.df.callActivityWithRetry(
      TICK,
      new df.RetryOptions(5000, 5),
      input,
    )
    // Azure caps custom status at 16 KB. Full results remain in private Blob records.
    context.df.setCustomStatus({
      runId: result.runId,
      status: result.status,
      ...(result.approvalId !== undefined ? { approvalId: result.approvalId } : {}),
    })
    if (result.status === 'succeeded' || result.status === 'failed') return result
    if (result.status === 'waiting') yield context.df.waitForExternalEvent('resume')
    else yield context.df.createTimer(new Date(context.df.currentUtcDateTime.getTime() + 1000))
  }
}

export function* azureAgentSchedule(context: AgentOrchestrationContext) {
  const input: NativeAgentSchedule = context.df.getInput()
  const retry = new df.RetryOptions(5000, 5)
  const schedule: DurableSchedule | null = yield context.df.callActivityWithRetry(
    NEXT,
    retry,
    input,
  )
  if (!schedule?.dueAt) return
  yield context.df.createTimer(new Date(schedule.dueAt))
  yield context.df.callActivityWithRetry(FIRE, retry, { ...input, dueAt: schedule.dueAt })
  context.df.continueAsNew(input)
}

export function* azureAutomationRun(context: AgentOrchestrationContext) {
  const input: AutomationIdentity = context.df.getInput()
  for (;;) {
    const result: AutomationResult = yield context.df.callActivityWithRetry(
      AUTOMATION_TICK,
      new df.RetryOptions(5000, 5),
      input,
    )
    context.df.setCustomStatus({
      runId: result.runId,
      status: result.status,
      waitingFor: result.waitingFor,
      wakeAt: result.wakeAt,
    })
    if (isAutomationTerminal(result)) return result
    if (result.wakeAt) yield context.df.createTimer(new Date(result.wakeAt))
    else if (result.status === 'waiting') yield context.df.waitForExternalEvent('resume')
    else yield context.df.createTimer(new Date(context.df.currentUtcDateTime.getTime() + 1000))
  }
}

export function* azureAutomationSchedule(context: AgentOrchestrationContext) {
  const input: AutomationScheduleIdentity = context.df.getInput()
  const retry = new df.RetryOptions(5000, 5)
  const schedule: StoredAutomationSchedule | null = yield context.df.callActivityWithRetry(
    AUTOMATION_NEXT,
    retry,
    input,
  )
  if (!schedule?.dueAt) return
  yield context.df.createTimer(new Date(schedule.dueAt))
  yield context.df.callActivityWithRetry(AUTOMATION_FIRE, retry, {
    key: input.key,
    generation: input.generation,
    dueAt: schedule.dueAt,
  })
  context.df.continueAsNew(input)
}

/** One native app hosts both workloads; activity environments carry the invocation's durable client. */
export function registerAzureWorkloads(hosts: {
  agent?: AgentRunHost<NodeJS.ProcessEnv>
  automations?: AutomationHost<NodeJS.ProcessEnv>
}): void {
  if (!hosts.agent && !hosts.automations) throw new Error('Declare an agent or automation host.')
  const connection = process.env['AzureWebJobsStorage']
  if (!connection) throw new Error('Azure durable execution requires AzureWebJobsStorage.')
  const records = azureExecutionRecords(connection)
  const environments = new WeakMap<object, { env: NodeJS.ProcessEnv; client: df.DurableClient }>()
  function environment(context: Parameters<typeof df.getClient>[0]): NodeJS.ProcessEnv {
    const env = { ...process.env }
    environments.set(env, { env, client: df.getClient(context) })
    return env
  }
  function nativeContext(env: Record<string, unknown> | undefined) {
    const current = env && environments.get(env)
    if (!current) {
      throw new Error('Pass the activity environment when accessing a native Azure workload.')
    }
    return current
  }
  function dispatcher(client: df.DurableClient, names: { run: string; schedule: string }) {
    return {
      startRun: (input: unknown) => client.startNew(names.run, { input }),
      startSchedule: (input: unknown) => client.startNew(names.schedule, { input }),
      async isActive(id: string) {
        const status = await client.getStatus(id)
        return (
          !!status &&
          ['Pending', 'Running', 'ContinuedAsNew', 'Suspended'].includes(status.runtimeStatus)
        )
      },
      wake: (id: string) => client.raiseEvent(id, 'resume', null),
      async cancel(id: string) {
        const status = await client.getStatus(id)
        if (
          status &&
          ['Pending', 'Running', 'ContinuedAsNew', 'Suspended'].includes(status.runtimeStatus)
        ) {
          await client.terminate(id, 'Workload cancelled or schedule replaced.')
        }
      },
    }
  }
  function agents(env: NodeJS.ProcessEnv): AgentPlatform {
    if (!hosts.agent) throw new Error('No Azure agent host was declared.')
    return createDurableAgentPlatform({
      host: hosts.agent,
      records,
      env,
      dispatcher: dispatcher(nativeContext(env).client, { run: RUN, schedule: SCHEDULE }),
    })
  }
  function automations(env: NodeJS.ProcessEnv) {
    if (!hosts.automations) throw new Error('No Azure automation host was declared.')
    return automationService({
      host: hosts.automations,
      records,
      env,
      dispatcher: dispatcher(nativeContext(env).client, {
        run: AUTOMATION_RUN,
        schedule: AUTOMATION_SCHEDULE,
      }),
    })
  }
  if (hosts.agent) {
    provideAgentPlatform((env) => agents(nativeContext(env).env))
    const host = hosts.agent
    df.app.activity(TICK, {
      extraInputs: [df.input.durableClient()],
      handler: (input: NativeAgentRun, context) =>
        durableAgentRuntime({ host, records, env: environment(context) }).tick(input),
    })
    df.app.activity(NEXT, {
      extraInputs: [df.input.durableClient()],
      handler: (input: NativeAgentSchedule, context) =>
        durableAgentRuntime({ host, records, env: environment(context) }).schedule(input),
    })
    df.app.activity(FIRE, {
      extraInputs: [df.input.durableClient()],
      handler: async (input: NativeAgentScheduleTick, context) => {
        await durableAgentRuntime({ host, records, env: environment(context) }).fire(input)
        return null
      },
    })
    df.app.orchestration(RUN, azureAgentRun)
    df.app.orchestration(SCHEDULE, azureAgentSchedule)
    app.http('cloudconfigAgents', {
      route: 'cloudconfig/agents',
      methods: ['POST'],
      authLevel: 'function',
      extraInputs: [df.input.durableClient()],
      async handler(request, context) {
        const command = await commandFrom(request)
        if (!command) return { status: 400 }
        return executeAgentCommand(agents(environment(context)), command)
      },
    })
  }
  if (hosts.automations) {
    provideAutomationPlatform((env) => automations(nativeContext(env).env).platform)
    df.app.activity(AUTOMATION_TICK, {
      extraInputs: [df.input.durableClient()],
      handler: (input: AutomationIdentity, context) =>
        automations(environment(context)).runtime.tick(input),
    })
    df.app.activity(AUTOMATION_NEXT, {
      extraInputs: [df.input.durableClient()],
      handler: (input: AutomationScheduleIdentity, context) =>
        automations(environment(context)).schedule(input),
    })
    df.app.activity(AUTOMATION_FIRE, {
      extraInputs: [df.input.durableClient()],
      handler: async (input: AutomationScheduleTick, context) => {
        await automations(environment(context)).fire(input)
        return null
      },
    })
    df.app.orchestration(AUTOMATION_RUN, azureAutomationRun)
    df.app.orchestration(AUTOMATION_SCHEDULE, azureAutomationSchedule)
    app.http('cloudconfigAutomations', {
      route: 'cloudconfig/automations',
      methods: ['POST'],
      authLevel: 'function',
      extraInputs: [df.input.durableClient()],
      async handler(request, context) {
        const command = await commandFrom(request)
        if (!command) return { status: 400 }
        const result = await executeAutomationCommand(
          automations(environment(context)).platform,
          command,
        )
        return { status: result.status, jsonBody: result.value }
      },
    })
  }
}

async function commandFrom(request: { json(): Promise<unknown> }): Promise<DurableCommand | null> {
  try {
    return readDurableCommand(await request.json())
  } catch {
    return null
  }
}

async function executeAgentCommand(platform: AgentPlatform, { action, input }: DurableCommand) {
  if (action === 'schedule') {
    if (typeof input.key !== 'string') return { status: 400 }
    const value = input.value
    let schedule: AgentSchedule | null = null
    if (value !== null) {
      if (!value || typeof value !== 'object') return { status: 400 }
      const cron = 'cron' in value ? value.cron : undefined
      const timeZone = 'timeZone' in value ? value.timeZone : undefined
      const payload = 'payload' in value ? value.payload : undefined
      if (
        typeof cron !== 'string' ||
        typeof timeZone !== 'string' ||
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        return { status: 400 }
      }
      schedule = { cron, timeZone, payload: Object.fromEntries(Object.entries(payload)) }
    }
    await platform.schedule(input.key, schedule)
    return { jsonBody: null }
  }
  const scope = input.scope as AgentScope | undefined
  if (
    !scope ||
    !Number.isSafeInteger(scope.ownerId) ||
    !Number.isSafeInteger(scope.agentId) ||
    typeof scope.workspace !== 'string' ||
    typeof scope.sessionId !== 'string' ||
    typeof input.runId !== 'string'
  ) {
    return { status: 400 }
  }
  const runs = await platform.runs(scope)
  if (action === 'status') return { jsonBody: await runs.status(input.runId) }
  if (action === 'resume') {
    await runs.resume(input.runId)
    return { jsonBody: null }
  }
  if (action === 'start' && typeof input.instructions === 'string') {
    const run: AgentRunRequest = {
      runId: input.runId,
      scope,
      instructions: input.instructions,
      payload: input.payload,
    }
    if (input.context && typeof input.context === 'object' && !Array.isArray(input.context)) {
      run.context = Object.fromEntries(Object.entries(input.context))
    }
    return { jsonBody: await runs.start(run) }
  }
  return { status: 400 }
}
