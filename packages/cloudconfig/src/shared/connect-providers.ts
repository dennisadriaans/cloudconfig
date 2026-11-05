/**
 * What a developer needs to register each built-in Connect provider: the
 * console page, the extra secrets beyond a client id and secret, the scopes
 * asked for by default, and which connection scopes fit the provider's model.
 *
 * Pure data, shared by the runtime, the CLI wizard, `cloudconfig doctor` and
 * the docs. Server behaviour lives in `connect/providers/`.
 */
import type { ConnectProviderId, ConnectionScope } from '../dsl/connect-config.js'

export interface ConnectExtraEnv {
  /** Option key the runtime reads (`appId`, `privateKey`, …). */
  key: string
  /** Env var suffix after `CONNECT_<PROVIDER>_`, e.g. `APP_ID`. */
  suffix: string
  label: string
  secret?: boolean
  /** Missing optional values disable a feature (webhooks) rather than the provider. */
  optional?: boolean
}

export interface ConnectProviderInfo {
  id: ConnectProviderId
  label: string
  console: { url: string; note?: string }
  /** Scopes requested when neither the config nor the request names any. */
  defaultScopes: readonly string[]
  /** Connection scopes that match the provider's own model. */
  allow: readonly ConnectionScope[]
  extraEnv: readonly ConnectExtraEnv[]
  /** Values the user enters before authorizing (Shopify's store domain). */
  startFields?: readonly { key: string; label: string; placeholder?: string }[]
  /** One line the wizard prints about webhooks, when the provider has app-level ones. */
  webhookNote?: string
}

export const CONNECT_PROVIDERS: Record<ConnectProviderId, ConnectProviderInfo> = {
  atlassian: {
    id: 'atlassian',
    label: 'Atlassian (Jira, Confluence)',
    console: {
      url: 'https://developer.atlassian.com/console/myapps/create-3lo-app/',
      note: 'OAuth 2.0 (3LO) app. Add the Jira API permission and the scopes below.',
    },
    defaultScopes: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'],
    allow: ['user', 'workspace'],
    extraEnv: [],
  },
  discord: {
    id: 'discord',
    label: 'Discord',
    console: {
      url: 'https://discord.com/developers/applications',
      note: 'Add a bot to the application. Its token is what agents post with.',
    },
    defaultScopes: ['bot', 'identify', 'guilds'],
    allow: ['workspace'],
    extraEnv: [
      { key: 'botToken', suffix: 'BOT_TOKEN', label: 'Bot token', secret: true },
      {
        key: 'publicKey',
        suffix: 'PUBLIC_KEY',
        label: 'Interactions public key',
        optional: true,
      },
    ],
  },
  github: {
    id: 'github',
    label: 'GitHub',
    console: {
      url: 'https://github.com/settings/apps/new',
      note: 'A GitHub App, not an OAuth App. Turn on "Request user authorization (OAuth) during installation" and set the Setup URL to the callback URL.',
    },
    defaultScopes: [],
    allow: ['user', 'workspace'],
    extraEnv: [
      { key: 'appSlug', suffix: 'APP_SLUG', label: 'App slug (github.com/apps/<slug>)' },
      { key: 'appId', suffix: 'APP_ID', label: 'App ID', optional: true },
      {
        key: 'privateKey',
        suffix: 'APP_PRIVATE_KEY',
        label: 'App private key (PEM)',
        secret: true,
        optional: true,
      },
      {
        key: 'webhookSecret',
        suffix: 'WEBHOOK_SECRET',
        label: 'Webhook secret',
        secret: true,
        optional: true,
      },
    ],
    webhookNote:
      'Set the app webhook URL to the printed webhook URL. Workspace connections need the App ID and private key to act as the installation.',
  },
  gitlab: {
    id: 'gitlab',
    label: 'GitLab',
    console: {
      url: 'https://gitlab.com/-/user_settings/applications',
      note: 'Confidential application. Self-managed instances set options.baseUrl.',
    },
    defaultScopes: ['read_user', 'api'],
    allow: ['user', 'workspace'],
    extraEnv: [],
  },
  google: {
    id: 'google',
    label: 'Google',
    console: {
      url: 'https://console.cloud.google.com/auth/clients/create',
      note: 'Web application. Enable each API you call and add its scopes to the consent screen.',
    },
    defaultScopes: ['openid', 'email', 'profile'],
    allow: ['user', 'workspace'],
    extraEnv: [],
  },
  hubspot: {
    id: 'hubspot',
    label: 'HubSpot',
    console: {
      url: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/create-an-app',
      note: 'Public app with OAuth. The client secret also signs webhooks.',
    },
    defaultScopes: [
      'oauth',
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
      'crm.objects.deals.read',
      'crm.objects.deals.write',
    ],
    allow: ['workspace', 'user'],
    extraEnv: [],
  },
  intercom: {
    id: 'intercom',
    label: 'Intercom',
    console: {
      url: 'https://app.intercom.com/a/apps/_/developer-hub',
      note: 'Enable OAuth on the app and choose its permissions there; Intercom takes no scope parameter.',
    },
    defaultScopes: [],
    allow: ['workspace'],
    extraEnv: [],
  },
  linear: {
    id: 'linear',
    label: 'Linear',
    console: {
      url: 'https://linear.app/settings/api/applications/new',
      note: 'Workspace connections install as the app (actor=app). Set the webhook URL for events.',
    },
    defaultScopes: ['read', 'write'],
    allow: ['user', 'workspace'],
    extraEnv: [
      {
        key: 'webhookSecret',
        suffix: 'WEBHOOK_SECRET',
        label: 'Webhook signing secret',
        secret: true,
        optional: true,
      },
    ],
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft 365',
    console: {
      url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade',
      note: 'Platform "Web". Multi-tenant apps keep options.tenant = "common".',
    },
    defaultScopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read'],
    allow: ['user', 'workspace'],
    extraEnv: [],
  },
  notion: {
    id: 'notion',
    label: 'Notion',
    console: {
      url: 'https://www.notion.so/profile/integrations',
      note: 'Public integration. Users choose the pages it can see during consent.',
    },
    defaultScopes: [],
    allow: ['workspace', 'user'],
    extraEnv: [
      {
        key: 'webhookSecret',
        suffix: 'WEBHOOK_SECRET',
        label: 'Webhook verification token',
        secret: true,
        optional: true,
      },
    ],
  },
  shopify: {
    id: 'shopify',
    label: 'Shopify',
    console: {
      url: 'https://partners.shopify.com/organizations',
      note: 'App with an offline access token. The client secret also signs webhooks.',
    },
    defaultScopes: ['read_orders', 'read_products', 'write_products', 'read_customers'],
    allow: ['workspace'],
    extraEnv: [],
    startFields: [{ key: 'shop', label: 'Store', placeholder: 'your-store.myshopify.com' }],
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    console: {
      url: 'https://api.slack.com/apps?new_app=1',
      note: 'Add bot token scopes under OAuth & Permissions. The signing secret verifies events.',
    },
    defaultScopes: ['channels:read', 'channels:history', 'chat:write', 'app_mentions:read'],
    allow: ['workspace'],
    extraEnv: [
      {
        key: 'signingSecret',
        suffix: 'SIGNING_SECRET',
        label: 'Signing secret',
        secret: true,
        optional: true,
      },
    ],
  },
}

export function connectProviderInfo(id: string): ConnectProviderInfo | undefined {
  return Object.hasOwn(CONNECT_PROVIDERS, id)
    ? CONNECT_PROVIDERS[id as ConnectProviderId]
    : undefined
}
