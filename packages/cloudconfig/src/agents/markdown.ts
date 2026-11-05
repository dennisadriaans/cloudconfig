import {
  createAgentDefinition,
  validateAgentDefinition,
  type AgentDefinition,
} from './definition.js'

/** JSON values in YAML frontmatter keep tool declarations portable and lossless. */
export function serializeAgentMarkdown(agent: AgentDefinition): string {
  const metadata = {
    runtime: agent.runtime ?? 'api',
    local_model: agent.localModel ?? '',
    provider: agent.provider,
    model: agent.model,
    status: agent.status,
    tool_choice: agent.toolChoice,
    tools: agent.tools,
  }
  return [
    '---',
    ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    '---',
    '',
    agent.markdown,
  ].join('\n')
}

/** Reads the exported frontmatter subset, plus the reference's enabled-name list. */
export function parseAgentMarkdown(
  source: string,
  current = createAgentDefinition(),
): AgentDefinition {
  source = source.replace(/\r\n/g, '\n')
  const agent = { ...current, markdown: source }
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (source.startsWith('---\n') && !frontmatter) {
    throw new Error('Close the agent settings with a second --- line.')
  }
  if (frontmatter) {
    agent.markdown = source.slice(frontmatter[0].length).replace(/^\n/, '')
    const values: Record<string, unknown> = {}
    for (const line of frontmatter[1]!.split('\n')) {
      if (!line.trim()) continue
      const field = line.match(
        /^(runtime|local_model|provider|model|status|tool_choice|tools):\s*(.*)$/,
      )
      if (!field) {
        throw new Error(
          'Use runtime, local_model, provider, model, status, tool_choice or tools in agent settings.',
        )
      }
      const key = field[1]!
      const raw = field[2]!
      if (key in values) throw new Error(`Use only one ${key} setting.`)
      try {
        values[key] = JSON.parse(raw)
      } catch {
        if (key === 'tools') {
          if (!/^\[\s*(?:[\w-]+\s*(?:,\s*[\w-]+\s*)*)?\]$/.test(raw)) {
            throw new Error('Use a JSON array for tools.')
          }
          values[key] = raw
            .slice(1, -1)
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)
        } else values[key] = raw.replace(/^'(.*)'$/, '$1')
      }
    }
    const tools = values.tools
    if (Array.isArray(tools) && tools.every((tool) => typeof tool === 'string') && tools.length) {
      if (tools.some((name) => !current.tools.some((tool) => tool.name === name))) {
        throw new Error('Add a tool declaration in the tools drawer before enabling it by name.')
      }
      values.tools = current.tools.map((tool) => ({ ...tool, enabled: tools.includes(tool.name) }))
    }
    Object.assign(agent, {
      ...(values.runtime !== undefined ? { runtime: values.runtime } : {}),
      ...(values.local_model !== undefined ? { localModel: values.local_model } : {}),
      ...(values.provider !== undefined ? { provider: values.provider } : {}),
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values.status !== undefined ? { status: values.status } : {}),
      ...(values.tool_choice !== undefined ? { toolChoice: values.tool_choice } : {}),
      ...(values.tools !== undefined ? { tools: values.tools } : {}),
    })
  }
  const issues = validateAgentDefinition({ ...agent })
  if (issues.length) throw new Error(issues[0]!.message)
  return agent
}
