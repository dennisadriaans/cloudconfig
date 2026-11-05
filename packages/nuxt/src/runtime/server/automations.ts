import { getAutomationPlatform, type AutomationPlatform } from '@cloudconfig/core/automations'
import { platformEnv, type H3Event } from './handler.js'

export function useCloudConfigAutomations(event: H3Event): AutomationPlatform {
  const platform = getAutomationPlatform(platformEnv(event))
  if (!platform) {
    throw new Error('Declare deploy.automations in cloud.config.ts to run background jobs.')
  }
  return platform
}
