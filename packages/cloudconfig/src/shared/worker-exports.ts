import type { AgentDeployment, DeployConfig, WorkerExport } from '../dsl/model-config.js'

/** Normalize the portable host declaration and the older Cloudflare-only spelling. */
export function agentDeployment(deploy: DeployConfig | undefined): AgentDeployment | undefined {
  if (deploy?.agent && deploy.agents?.length) {
    throw new Error('Use deploy.agent or the legacy deploy.agents, not both.')
  }
  if ((deploy?.agents?.length ?? 0) > 1) {
    throw new Error('Declare one agent host; it serves every saved agent and session.')
  }
  const host = deploy?.agent
  if (!host) return deploy?.agents?.[0]
  return {
    entry: host.entry,
    className: host.cloudflare?.className ?? 'CloudconfigAgent',
    binding: host.cloudflare?.binding ?? 'CLOUDCONFIG_AGENTS',
    migrationTag: host.cloudflare?.migrationTag ?? 'cloudconfig-agents-v1',
  }
}

export function automationDeployment(
  deploy: DeployConfig | undefined,
): AgentDeployment | undefined {
  const host = deploy?.automations
  if (!host) return
  return {
    entry: host.entry,
    className: host.cloudflare?.className ?? 'CloudconfigAutomations',
    binding: host.cloudflare?.binding ?? 'CLOUDCONFIG_AUTOMATIONS',
    migrationTag: host.cloudflare?.migrationTag ?? 'cloudconfig-automations-v1',
  }
}

/** Browser-safe contract; importing the config never imports Worker classes. */
export function workerExports(deploy: DeployConfig | undefined): WorkerExport[] {
  const host = agentDeployment(deploy)
  const automation = automationDeployment(deploy)
  const durable = [...(host ? [host] : []), ...(automation ? [automation] : [])]
  const entries = [...durable, ...(deploy?.workflows ?? [])]
  const bindings = new Set<string>()
  const classes = new Set<string>()
  for (const entry of entries) {
    if (!/^[A-Za-z_$][\w$]*$/.test(entry.className) || !/^[A-Za-z_][\w]*$/.test(entry.binding)) {
      throw new Error('Worker class names and bindings must be identifiers.')
    }
    if (!entry.entry || entry.entry.startsWith('/') || entry.entry.split(/[\\/]/).includes('..')) {
      throw new Error('Worker entries must be files inside the project.')
    }
    if (classes.has(entry.className) || bindings.has(entry.binding)) {
      throw new Error('Worker classes and bindings must be unique in cloud.config.ts.')
    }
    classes.add(entry.className)
    bindings.add(entry.binding)
  }
  for (const entry of durable) {
    if (!/^[\w-]+$/.test(entry.migrationTag)) {
      throw new Error('Give each Agent a stable migration tag.')
    }
  }
  for (const entry of deploy?.workflows ?? []) {
    if (!/^[a-z0-9_-]+$/.test(entry.name)) throw new Error('Use a valid Workflow name.')
  }
  return entries
}
