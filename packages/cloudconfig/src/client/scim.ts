/** Typed client for organization directory provisioning through CloudConfig's SCIM routes. */
import type { ClientOptions } from './index.js'
import { sessionRequest } from './request.js'

export interface ScimToken {
  uid: string
  label: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export interface ScimSecret {
  /** Shown once. Paste it into the identity provider. */
  token: string
  /** The SCIM base URL the identity provider calls. */
  baseUrl: string
  credential: ScimToken
}

export interface ScimClient {
  list(): Promise<{ tokens: ScimToken[]; baseUrl: string }>
  create(label?: string): Promise<ScimSecret>
  revoke(uid: string): Promise<void>
}

export function createScimClient(options: ClientOptions = {}): ScimClient {
  const { json, post } = sessionRequest(options, '/api/auth')

  return {
    list: () => json('/scim-connections'),
    create: (label) => post('/scim-connections', label ? { label } : {}),
    revoke: async (uid) => {
      await post('/scim-connections/revoke', { id: uid })
    },
  }
}
