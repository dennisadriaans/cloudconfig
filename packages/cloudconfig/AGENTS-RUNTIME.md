# Deploying agents and automations from Nuxt

Saved definitions remain portable and private in CloudConfig models. The Nuxt
module selects native durable execution for the app host: Cloudflare Agents,
Vercel Workflow, or Azure Durable Functions. Install the selected runtime's
optional peer dependencies in the application. The public setup guide is
[Deploy Agents](../website-next/content/docs/5.deployment/8.agents.md).

The layers are separated so other platforms reuse everything but the last:

| Module                                       | Platform | Owns                                                            |
| -------------------------------------------- | -------- | --------------------------------------------------------------- |
| `@cloudconfig/core/agents/runtime`           | any      | Provider adapters, tool validation, the model/tool loop         |
| `@cloudconfig/core/agents/runs`              | any      | The durable run state machine over an `AgentRunStore`           |
| `@cloudconfig/core/agents/platform`          | any      | `defineAgentHost`, the `AgentPlatform` port, the memory adapter |
| `@cloudconfig/core/agents/schedules`         | any      | Scope naming and cron; `agentStub` loads the SDK on demand      |
| `@cloudconfig/core/agents/cloudflare/client` | any      | The Cloudflare `AgentPlatform` adapter for callers              |
| `@cloudconfig/core/agents/cloudflare`        | Workers  | SQLite run store, alarms and the Agent class                    |
| `@cloudconfig/core/agents/durable`           | any      | Bounded execution, durable schedules and native dispatch ports |
| `@cloudconfig/core/agents/vercel`            | Vercel   | Workflow dispatch and records in the configured database       |
| `@cloudconfig/core/agents/azure`             | Azure    | Function registration, orchestration and private Blob records  |
| `@cloudconfig/core/agents/azure/client`      | server   | Authenticated requests to the native Function app              |

Application code depends on two platform-free pieces only:

- **The host.** The `deploy.agent` entry default-exports
  `defineAgentHost({ resolve, approval, scheduled, execute })`. Prefer the portable
  `deploy.agent: { entry: 'server/cloudconfig/agents.ts' }` declaration; the older
  `deploy.agents` spelling is also accepted. The host resolves a
  saved agent, provider keys and allowed tools for an authenticated owner and
  workspace.
- **The port.** `useCloudConfigAgents(event)` in Nuxt, or
  `getAgentPlatform(env)` elsewhere, returns an `AgentPlatform`:
  `runs(scope)` opens `start`, `status` and `resume`; `schedule(key, value)`
  replaces or cancels a cron schedule.

```ts
// server/cloudconfig/agents.ts: the deploy.agent entry
export default defineAgentHost({ resolve, approval, scheduled })

// Any server route: the same code on every target
const runs = await useCloudConfigAgents(event).runs(scope)
return runs.start({ runId, scope, payload, instructions })
```

The framework is the composition root. In a Cloudflare build the Nuxt module
exports `createCloudflareAgent(host)` under `className` and binds the port to
`cloudflareAgentPlatform(env[binding])`; in development it binds
`createMemoryAgentPlatform(host)`. Only that generated code names a platform.
A new target adds an adapter pair: an `AgentRunStore` with a `dispatch` that
continues a run outside the request (a queue message, a durable function) for
`createAgentRunner`, and an `AgentPlatform` for callers.

Vercel generates consumer-source Workflow functions and steps through the
official `workflow/nuxt` integration. Private records and compare-and-set leases
live in the configured application database. Each activity performs one new
model or tool call, replaying completed receipts. Approval waits use durable
sleep and can be woken by `resume`; schedules continue in new Workflow runs to
bound history. The generated manifest and Vercel queue triggers are part of the
prebuilt deployment.

Azure deploys a separate Node.js 22 Function app on the web application's App
Service plan and provisions a Storage account. Durable Functions activities,
external events, and timers own continuation. Private Blob records use ETags
for conditional writes and leases; the orchestration calls `continueAsNew` for
recurring schedules. The web app receives only a Function endpoint and key, and
calls it through `azureAgentPlatform`. Provider keys stay in Function settings.
The host uses portable imports because it runs outside Nuxt in this process.

Compose `agentModels` from `@cloudconfig/core/agents` into your backend.

```ts
deploy: {
  target: 'cloudflare', // 'vercel' | 'azure'
  agent: { entry: 'server/cloudconfig/agents.ts' },
  secrets: ['OPENAI_API_KEY'],
  optionalSecrets: ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY'],
}
```

On Cloudflare, the Nuxt module composes the Agent export with Nitro's existing
entry. One agent host serves every saved agent. Run
`cloudconfig db generate` and `cloudconfig deploy --dry-run`, then use
`cloudconfig deploy` to build, reconcile bindings, append SQLite Durable Object
migrations, provision D1/R2, migrate and deploy. Existing bindings and migrations
are retained. A conflicting binding or missing built export stops deployment.
Keep migration tags stable; class renames need an explicit Cloudflare migration.
Cloudflare-only multi-step jobs can also declare `deploy.workflows` entries with
their `entry`, `className`, `binding`, and `name`.
Standalone Workers export `createCloudflareAgent(host)` under `className`, and
the workflow classes, from their own entry.

The HTTP gateway must derive owner/workspace from its authenticated session and
check ownership before accepting a run, then call `runs(scope)`. Do not mount
the generic public Agent router. A run ID is an idempotency key within that
owner/workspace/agent/session. Poll `status(runId)` for progress and results.
`context` on a run request is set by the gateway, never by a client, and reaches
the host's `resolve` and `execute`.

`runSavedAgent` from `@cloudconfig/core/agents/runtime` supports OpenAI,
Anthropic and Gemini. Pass a checkpoint callback for each provider round.
Tool calls carry stable call IDs and idempotency keys. The host must recheck
current permissions at dispatch. JSON Schema validation rejects ungranted
tools and invalid arguments before calling a host.

Every durable adapter persists tool dispatch before external I/O and saves its
result afterward. Completed calls replay from receipts. A crash in that gap
stops the run for review; it cannot promise exactly-once delivery to an external
service. Resolve the external result before starting another run.

An approval result pauses the run. After the owner responds, call
`runs(scope).resume(runId)`; the host's `approval` returns the action's actual result, or the
approval-required value while it is still pending. Vercel waits through durable
sleep; Azure waits for an external event. The event is only a wake-up signal and
the saved approval remains authoritative. Provider deadlines refresh on each
continuation after a long wait.

`schedule(key, { cron, timeZone, payload })` uses five-field cron and an IANA
time zone, including daylight saving transitions; `schedule(key, null)` cancels
future runs of that key. Hooks receive runtime `env` on REST, MCP and
server-client writes, so all entry points can synchronize a schedule through
`getAgentPlatform(env)`. It is undefined outside an application that declares
agents, such as the CLI, where hooks skip synchronization. Scheduled handlers
should reload the current automation, recheck its owner and active status, and
deduplicate using the scheduled timestamp before creating a Workflow.

In development the memory adapter keeps runs and fires schedules inside the
dev server process; both end with it. Production validates the actual build
preset and selects a durable adapter. It never falls back to memory. Automatic
Vercel agent builds currently require Nuxt. Cloudflare Workflow class exports
remain Cloudflare-specific.

Changing hosts does not move in-flight executions or execution history between
native runtimes. Drain old runs or keep that runtime for approvals, and recreate
schedules on the destination. Application database selection is independent.

## Portable application jobs

Declare `deploy.automations: { entry, schedules }` for non-model tasks. The host
default-exports `defineAutomationHost({ authorize, tasks })` from
`@cloudconfig/core/automations`. Nuxt exposes `useCloudConfigAutomations(event)`;
other native callbacks use `getAutomationPlatform(env)` with the activity env.
Both workload ports are bound inside Cloudflare alarms, Vercel steps, and Azure
activities, including callbacks which start another workload.

`runs(scope)` provides start, status, resume, signal, and cancel. The host
authorizes acceptance, status/control, and every continuation. A null owner
denotes trusted workspace/system work, never an anonymous browser principal.
The HTTP gateway must derive scopes from an authenticated session.

Tasks use named `context.step`, `context.sleep`, and `context.waitForEvent`
checkpoints. One new external action runs per native activity. Completed receipts
replay; retries require explicit idempotence and a stable external idempotency key.
Uncertain non-idempotent dispatches fail for review. Pass the deadline signal to
I/O and bound each action to three minutes. Keep JSON payloads/results and stable
checkpoint names across deployments. Cancellation prevents future actions; it
cannot undo an action already completed outside the process.

The shared `durable` modules own compare-and-set records, activity leases, and
execution-pointer deduplication. Agents retain their existing table/container
names and record keys. Automations use distinct key namespaces. Cloudflare jobs
use their own SQLite class; Vercel uses the configured database; Azure shares the
native Function app and private Blob account with agents. Schedule generations
and occurrence timestamps fence stale alarms and deduplicate logical jobs.

After publication, the CLI synchronizes only source-declared schedules through a
private authenticated control endpoint. It generates and uploads an ignored
`CLOUDCONFIG_AUTOMATION_ADMIN_KEY`. Protected Vercel projects also need a local/CI
deployment bypass secret. Dry runs never generate the key or call the endpoint.
An unchanged schedule retains its next occurrence; removing one stops it.

Connect adds bounded scheduled refresh, key rotation for connections and MCP
clients, and abandoned-connection cleanup when an automation host is declared.
Its persisted cursor prevents earlier rows from starving later ones. Verified
webhooks can enqueue a named task before acknowledgement. Vendor retries reuse
the same scoped run ID; native queue outages return an error so delivery retries.
Existing inline handlers remain supported. Application tasks must recheck current
connection and organization permissions before using credentials.

See [Deploy Automations](../website-next/content/docs/5.deployment/9.automations.md)
for the full contract, and [Platform Support](../website-next/content/docs/5.deployment/10.support.md)
for framework coverage, verification scope, and file transport limits.
