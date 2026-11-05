/**
 * Where a developer goes to create the OAuth app for a provider.
 *
 * This is the part of "ship OAuth ready" nobody else automates: the credentials
 * are always the developer's own, so the least a framework can do is name the
 * console page, the exact redirect URI to paste, and the two environment
 * variables the value lands in. Pure data — the CLI wizard renders it.
 */
import type { AuthProviderId } from '../dsl/auth-config.js'
import { capitalize } from './capitalize.js'

export interface ProviderConsole {
  label: string
  /** Deep link to the page that creates an OAuth client. */
  url: string
  /** One line of provider-specific gotcha, when there is one. */
  note?: string
}

const CONSOLES: Partial<Record<AuthProviderId, ProviderConsole>> = {
  google: {
    label: 'Google',
    url: 'https://console.cloud.google.com/auth/clients/create',
    note: 'Application type "Web application". An unverified app is capped at 100 users.',
  },
  github: {
    label: 'GitHub',
    url: 'https://github.com/settings/applications/new',
    note: 'Add the printed development and production callback URLs to the OAuth app.',
  },
  microsoft: {
    label: 'Microsoft Entra ID',
    url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade',
    note: 'Redirect URI platform: "Web". Multi-tenant apps also need `options.tenantId`.',
  },
  apple: {
    label: 'Apple',
    url: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
    note: 'The client secret is a signed JWT you regenerate every 6 months.',
  },
  discord: { label: 'Discord', url: 'https://discord.com/developers/applications' },
  slack: { label: 'Slack', url: 'https://api.slack.com/apps' },
  gitlab: { label: 'GitLab', url: 'https://gitlab.com/-/user_settings/applications' },
  linkedin: { label: 'LinkedIn', url: 'https://www.linkedin.com/developers/apps/new' },
  facebook: { label: 'Facebook', url: 'https://developers.facebook.com/apps' },
  twitch: { label: 'Twitch', url: 'https://dev.twitch.tv/console/apps/create' },
  spotify: { label: 'Spotify', url: 'https://developer.spotify.com/dashboard' },
  notion: { label: 'Notion', url: 'https://www.notion.so/my-integrations' },
  figma: { label: 'Figma', url: 'https://www.figma.com/developers/apps' },
  twitter: { label: 'X (Twitter)', url: 'https://developer.x.com/en/portal/dashboard' },
  reddit: { label: 'Reddit', url: 'https://www.reddit.com/prefs/apps' },
  dropbox: { label: 'Dropbox', url: 'https://www.dropbox.com/developers/apps/create' },
  zoom: { label: 'Zoom', url: 'https://marketplace.zoom.us/develop/create' },
  linear: { label: 'Linear', url: 'https://linear.app/settings/api/applications/new' },
  kick: { label: 'Kick', url: 'https://kick.com/settings/developer' },
  polar: { label: 'Polar', url: 'https://polar.sh/settings' },
}

export function providerConsole(id: AuthProviderId): ProviderConsole {
  return (
    CONSOLES[id] ?? {
      label: capitalize(id),
      url: `https://www.google.com/search?q=${encodeURIComponent(`${id} create oauth app client id`)}`,
    }
  )
}

export function providerLabel(id: AuthProviderId): string {
  return CONSOLES[id]?.label ?? capitalize(id)
}
