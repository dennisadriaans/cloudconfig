import { resolve } from 'node:path'
import { agentDeployment, automationDeployment, type AnyConfig } from '../index.js'
import { GENERATED_VOID_HEADER, relativeImportPath } from './paths.js'

interface VoidWorkerModuleOptions {
  config: AnyConfig
  projectDir: string
  configPath: string
  modulePath: string
}

/** Render Worker-only adapters without importing Cloudflare classes in the config process. */
export function renderVoidWorkerModule(options: VoidWorkerModuleOptions): string {
  const { config, projectDir, configPath, modulePath } = options
  const host = agentDeployment(config.deploy)
  const automations = automationDeployment(config.deploy)
  const importEntry = (entry: string) =>
    JSON.stringify(relativeImportPath(modulePath, resolve(projectDir, entry)))
  const lines = [GENERATED_VOID_HEADER]

  if (host) {
    lines.push(
      `import { createCloudflareAgent } from '@cloudconfig/core/agents/cloudflare'`,
      `import { provideAgentPlatform } from '@cloudconfig/core/agents/platform'`,
      `import { cloudflareAgentPlatform } from '@cloudconfig/core/agents/cloudflare/client'`,
      `import agentHost from ${importEntry(host.entry)}`,
      '',
      `export const ${host.className} = createCloudflareAgent(agentHost)`,
      `provideAgentPlatform((env) => cloudflareAgentPlatform(env?.[${JSON.stringify(host.binding)}]))`,
      '',
    )
  }

  if (automations) {
    lines.push(
      `import { createCloudflareAutomations } from '@cloudconfig/core/automations/cloudflare'`,
      `import { withConnectAutomations } from '@cloudconfig/core/automations/connect'`,
      `import { resolveConfigExport } from '@cloudconfig/core'`,
      `import automationHost from ${importEntry(automations.entry)}`,
      `import * as configModule from ${importEntry(configPath)}`,
      '',
      `const automationConfig = resolveConfigExport(configModule, ${JSON.stringify(configPath)})`,
      `export const ${automations.className} = createCloudflareAutomations(`,
      '  withConnectAutomations(automationHost, automationConfig),',
      `  { binding: ${JSON.stringify(automations.binding)} },`,
      ')',
      '',
    )
  }

  for (const workflow of config.deploy?.workflows ?? []) {
    lines.push(`export { ${workflow.className} } from ${importEntry(workflow.entry)}`)
  }
  return [...lines, ''].join('\n')
}
