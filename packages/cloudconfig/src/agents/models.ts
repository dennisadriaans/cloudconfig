import { model } from '../dsl/model-config.js'
import { t } from '../dsl/fields.js'
import { AGENT_RUNTIMES, agentName, validateAgentDefinition } from './definition.js'

/** Compose into config.models to get private agent CRUD, SDK, MCP and migrations. */
export const agentModels = {
  agent: model(
    {
      name: t.text().default('Untitled agent'),
      markdown: t.textarea().required(),
      provider: t.select(['openai', 'anthropic', 'google']).default('anthropic'),
      model: t.text().default('claude-sonnet-4-5'),
      status: t.select(['draft', 'active']).default('draft'),
      toolChoice: t.select(['auto', 'required', 'none']).default('auto'),
      tools: t.json().default([]),
      runtime: t.select(AGENT_RUNTIMES).default('api'),
      localModel: t.text().default(''),
      ownerId: t.number().required().serverOnly(),
    },
    {
      label: 'Agents',
      access: {
        list: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
        read: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
        create: ({ user }) => !!user,
        update: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
        delete: ({ user, where }) => (user ? where('ownerId', 'eq', user.id) : false),
      },
      hooks: {
        beforeCreate: ({ user }, input) => ({
          ...input,
          name: agentName(String(input.markdown ?? '')),
          ownerId: user!.id,
        }),
        beforeUpdate: ({ user }, input) => {
          const patch = { ...input }
          delete patch.name
          return {
            ...patch,
            ...(typeof input.markdown === 'string' ? { name: agentName(input.markdown) } : {}),
            ownerId: user!.id,
          }
        },
      },
      validate: validateAgentDefinition,
    },
  ),
}

export type AgentsConfig = { models: typeof agentModels }
