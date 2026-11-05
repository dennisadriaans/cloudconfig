import { getAgentPlatform, type AgentPlatform } from '@cloudconfig/core/agents/platform'
import { platformEnv, type H3Event } from './handler.js'

/**
 * Run saved agents and keep their schedules. The module binds the adapter for
 * the build target, so callers never name a platform, binding or SDK.
 */
export function useCloudConfigAgents(event: H3Event): AgentPlatform {
  const platform = getAgentPlatform(platformEnv(event))
  if (!platform) throw new Error('Declare deploy.agents in cloud.config.ts to run saved agents.')
  return platform
}
