import type { WebhookDelivery } from './runtime.js'
import { automationDigest } from '../automations/identity.js'
import { getAutomationPlatform } from '../automations/platform.js'

/** Verified input only. Retry identity includes the connection, so workspace deliveries cannot collide. */
export async function enqueueConnectWebhook(options: {
  task: string
  delivery: WebhookDelivery
  env: Record<string, unknown> | undefined
}): Promise<void> {
  const platform = getAutomationPlatform(options.env)
  if (!platform) {
    throw new Error('Declare deploy.automations to dispatch integration webhooks durably.')
  }
  const { delivery, task } = options
  const connection = delivery.connection
  const scope = {
    ownerId: connection.scope === 'user' ? connection.userId : null,
    workspace:
      connection.organizationId === null ? 'personal' : `organization:${connection.organizationId}`,
  }
  const identity = delivery.deliveryId || (await automationDigest(delivery.payload))
  const runId = `webhook_${await automationDigest([delivery.provider, delivery.event, connection.uid, identity])}`
  await (await platform.runs(scope)).start({ scope, runId, task, payload: delivery })
}
