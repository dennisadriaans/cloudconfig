import type { AutomationIdentity, AutomationScope } from './types.js'

export async function automationDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  )
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function validateAutomationScope(scope: AutomationScope): void {
  if (
    !scope ||
    (scope.ownerId !== null && (!Number.isSafeInteger(scope.ownerId) || scope.ownerId < 1)) ||
    typeof scope.workspace !== 'string' ||
    !scope.workspace ||
    scope.workspace.length > 200
  ) {
    throw new Error('Use a trusted automation owner and workspace scope.')
  }
}

export async function automationInstance(scope: AutomationScope): Promise<string> {
  validateAutomationScope(scope)
  return `cloudconfig-automations-${await automationDigest([scope.ownerId, scope.workspace])}`
}

export async function automationRunKey(input: AutomationIdentity): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.runId)) throw new Error('Use a valid automation run ID.')
  return `${await automationInstance(input.scope)}:${input.runId}`
}

export function assertAutomationScope(input: AutomationIdentity, scope: AutomationScope): void {
  validateAutomationScope(scope)
  if (input.scope?.ownerId !== scope.ownerId || input.scope.workspace !== scope.workspace) {
    throw new Error('An automation belongs to the owner and workspace it was opened for.')
  }
}
