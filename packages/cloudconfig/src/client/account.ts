import type { ClientOptions } from './index.js'
import { sessionRequest } from './request.js'

export interface AuthAccount {
  id: number
  accountId: string
  providerId: string
  userId: number
  scopes: string[]
  createdAt: string
  updatedAt: string
}

export interface AccountClient {
  getTwoFactorStatus(): Promise<TwoFactorStatus>
  updateUser(
    input: { name?: string; image?: string | null } & Record<string, unknown>,
  ): Promise<void>
  deleteUser(input?: { password?: string; token?: string; callbackURL?: string }): Promise<{
    success: boolean
    message: string
  }>
  listAccounts(): Promise<AuthAccount[]>
  changePassword(input: {
    currentPassword: string
    newPassword: string
    revokeOtherSessions?: boolean
  }): Promise<void>
}

export interface TwoFactorStatus {
  enabled: boolean
  method: 'email' | 'passkey' | null
  pending: boolean
}

/** Small, dependency-free client for Better Auth's self-service account endpoints. */
export function createAccountClient(options: ClientOptions = {}): AccountClient {
  const { json, post } = sessionRequest(options, '/api/auth')

  return {
    getTwoFactorStatus() {
      return json('/two-factor/status')
    },
    async updateUser(input) {
      await post('/update-user', input)
    },
    deleteUser(input = {}) {
      return post('/delete-user', input)
    },
    async listAccounts() {
      return (await json<AuthAccount[]>('/list-accounts')).map((account) => ({
        ...account,
        id: Number(account.id),
        userId: Number(account.userId),
      }))
    },
    async changePassword(input) {
      await post('/change-password', input)
    },
  }
}
