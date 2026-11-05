import type { PagedResult } from '../shared/paged-result.js'
import type { ClientOptions } from './index.js'
import { sessionRequest } from './request.js'
import type { TableQuery, TableSource } from './table.js'

export interface AdminUser {
  id: number
  name: string
  email: string
  emailVerified: boolean
  image: string | null
  createdAt: string
  updatedAt: string
  role: string | null
  banned: boolean | null
  banReason: string | null
  banExpires: string | null
}

export interface AdminSession {
  id: number
  userId: number
  token: string
  expiresAt: string
  createdAt: string
  updatedAt: string
  ipAddress?: string | null
  userAgent?: string | null
  impersonatedBy?: string | null
}

export interface AdminUserCreate {
  name: string
  email: string
  password?: string
  role?: string | string[]
  data?: Record<string, unknown>
}

export interface AdminUserUpdate {
  name?: string
  email?: string
  emailVerified?: boolean
  image?: string | null
  role?: string | string[]
}

export type AdminPermission = Record<string, readonly string[]>

export interface AdminClient extends TableSource<
  AdminUser,
  AdminUserCreate,
  AdminUserUpdate,
  keyof AdminUser
> {
  getUser(userId: number): Promise<AdminUser>
  updateUser(userId: number, data: AdminUserUpdate & Record<string, unknown>): Promise<AdminUser>
  setRole(userId: number, role: string | string[]): Promise<AdminUser>
  setUserPassword(userId: number, newPassword: string): Promise<void>
  banUser(userId: number, options?: { reason?: string; expiresIn?: number }): Promise<AdminUser>
  unbanUser(userId: number): Promise<AdminUser>
  listUserSessions(userId: number): Promise<AdminSession[]>
  revokeUserSession(sessionToken: string): Promise<void>
  revokeUserSessions(userId: number): Promise<void>
  impersonateUser(userId: number): Promise<{ user: AdminUser; session: AdminSession }>
  stopImpersonating(): Promise<{ user: AdminUser; session: AdminSession }>
  removeUser(userId: number): Promise<void>
  hasPermission(permissions: AdminPermission): Promise<boolean>
}

/** Better Auth admin client plus a table-compatible list/create/update/delete facade. */
export function createAdminClient(options: ClientOptions = {}): AdminClient {
  const { request, json, post } = sessionRequest(options, '/api/auth')

  function user(value: AdminUser): AdminUser {
    return { ...value, id: Number(value.id) }
  }

  function session(value: AdminSession): AdminSession {
    return { ...value, id: Number(value.id), userId: Number(value.userId) }
  }

  const client: AdminClient = {
    async list(query: TableQuery<keyof AdminUser> = {}, init) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
        }
      }
      return json<PagedResult<AdminUser>>(`/manage/users?${params}`, init)
    },
    create(input) {
      return post<AdminUser>('/manage/users', input)
    },
    update(id, input) {
      return json<AdminUser>(`/manage/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      })
    },
    async delete(id) {
      await request(`/manage/users/${id}`, { method: 'DELETE' })
    },
    async getUser(userId) {
      return user(await json<AdminUser>(`/admin/get-user?id=${encodeURIComponent(String(userId))}`))
    },
    async updateUser(userId, data) {
      return user(await post<AdminUser>('/admin/update-user', { userId, data }))
    },
    async setRole(userId, role) {
      const result = await post<{ user: AdminUser }>('/admin/set-role', { userId, role })
      return user(result.user)
    },
    async setUserPassword(userId, newPassword) {
      await post('/admin/set-user-password', { userId, newPassword })
    },
    async banUser(userId, options = {}) {
      const result = await post<{ user: AdminUser }>('/admin/ban-user', {
        userId,
        ...(options.reason ? { banReason: options.reason } : {}),
        ...(options.expiresIn !== undefined ? { banExpiresIn: options.expiresIn } : {}),
      })
      return user(result.user)
    },
    async unbanUser(userId) {
      const result = await post<{ user: AdminUser }>('/admin/unban-user', { userId })
      return user(result.user)
    },
    async listUserSessions(userId) {
      const result = await post<{ sessions: AdminSession[] }>('/admin/list-user-sessions', {
        userId,
      })
      return result.sessions.map(session)
    },
    async revokeUserSession(sessionToken) {
      await post('/admin/revoke-user-session', { sessionToken })
    },
    async revokeUserSessions(userId) {
      await post('/admin/revoke-user-sessions', { userId })
    },
    async impersonateUser(userId) {
      const result = await post<{ user: AdminUser; session: AdminSession }>(
        '/admin/impersonate-user',
        { userId },
      )
      return { user: user(result.user), session: session(result.session) }
    },
    async stopImpersonating() {
      const result = await post<{ user: AdminUser; session: AdminSession }>(
        '/admin/stop-impersonating',
      )
      return { user: user(result.user), session: session(result.session) }
    },
    async removeUser(userId) {
      await post('/admin/remove-user', { userId })
    },
    async hasPermission(permissions) {
      const result = await post<{ success: boolean }>('/admin/has-permission', { permissions })
      return result.success
    },
  }
  return client
}
