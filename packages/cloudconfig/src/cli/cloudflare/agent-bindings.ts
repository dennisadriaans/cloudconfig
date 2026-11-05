import { applyEdits, modify, parse } from 'jsonc-parser'
import type { DeployConfig } from '../../dsl/model-config.js'
import {
  agentDeployment,
  automationDeployment,
  workerExports,
} from '../../shared/worker-exports.js'

/** Preserve unrelated objects, workflows, migrations, comments and ordering. */
export function reconcileAgentBindings(text: string, deploy: DeployConfig): string {
  workerExports(deploy)
  const host = agentDeployment(deploy)
  const automation = automationDeployment(deploy)
  const hosts = [...(host ? [host] : []), ...(automation ? [automation] : [])]
  let config = parse(text) as Record<string, unknown>
  function set(path: (string | number)[], value: unknown) {
    text = applyEdits(
      text,
      modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    )
    config = parse(text) as Record<string, unknown>
  }
  const durable = config['durable_objects'] as { bindings?: Record<string, unknown>[] } | undefined
  const agents = [...(durable?.bindings ?? [])]
  const migrations = [...((config['migrations'] as Record<string, unknown>[] | undefined) ?? [])]
  for (const entry of hosts) {
    const existing = agents.find((item) => item['name'] === entry.binding)
    if (existing && (existing['class_name'] !== entry.className || existing['script_name'])) {
      throw new Error(
        `Agent binding ${entry.binding} conflicts with Wrangler. Resolve it before deploying.`,
      )
    }
    if (!existing) agents.push({ name: entry.binding, class_name: entry.className })
    const introduced = migrations.find((item) =>
      [
        ...((item['new_sqlite_classes'] as string[] | undefined) ?? []),
        ...((item['new_classes'] as string[] | undefined) ?? []),
      ].includes(entry.className),
    )
    if (
      introduced &&
      !(introduced['new_sqlite_classes'] as string[] | undefined)?.includes(entry.className)
    ) {
      throw new Error(`Agent ${entry.className} requires a SQLite Durable Object migration.`)
    }
    if (introduced && introduced['tag'] !== entry.migrationTag) {
      throw new Error(
        `Agent ${entry.className} was introduced by migration ${String(introduced['tag'])}. Keep its migrationTag unchanged.`,
      )
    }
    if (!introduced) {
      const migration = migrations.find((item) => item['tag'] === entry.migrationTag)
      if (migration) {
        throw new Error(
          `Migration tag ${entry.migrationTag} already exists; use a new tag for ${entry.className}.`,
        )
      }
      migrations.push({ tag: entry.migrationTag, new_sqlite_classes: [entry.className] })
    }
  }
  if (hosts.length) {
    set(['durable_objects', 'bindings'], agents)
    set(['migrations'], migrations)
  }
  const workflows = [...((config['workflows'] as Record<string, unknown>[] | undefined) ?? [])]
  for (const entry of deploy.workflows ?? []) {
    const existing = workflows.find(
      (item) => item['binding'] === entry.binding || item['name'] === entry.name,
    )
    if (
      existing &&
      (existing['binding'] !== entry.binding ||
        existing['name'] !== entry.name ||
        existing['class_name'] !== entry.className ||
        existing['script_name'])
    ) {
      throw new Error(
        `Workflow ${entry.binding} conflicts with Wrangler. Resolve it before deploying.`,
      )
    }
    if (!existing) {
      workflows.push({ name: entry.name, binding: entry.binding, class_name: entry.className })
    }
  }
  if (deploy.workflows?.length) set(['workflows'], workflows)
  return text
}

/** Check the public export names, including Rollup's renamed local declarations. */
export function assertWorkerExports(code: string, deploy: DeployConfig): void {
  const names = new Set<string>()
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const item of match[1]!.split(',')) {
      names.add(
        item
          .trim()
          .split(/\s+as\s+/)
          .at(-1)!,
      )
    }
  }
  for (const entry of workerExports(deploy)) {
    const name = entry.className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const declaration = new RegExp(
      `export\\s+(?:class|const|let|var|function)\\s+${name}(?![\\w$])`,
    )
    if (!names.has(entry.className) && !declaration.test(code)) {
      throw new Error(
        `The built Worker does not export ${entry.className}. No database resources or migrations were changed.`,
      )
    }
  }
}
