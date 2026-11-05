/**
 * The auth surface, described structurally.
 *
 * These are deliberately CloudConfig's own types rather than better-auth's: the
 * package is an optional peer, so a project that never enables auth must not
 * need it installed for `cloudconfig/server`'s declarations to typecheck.
 */
export interface AuthUser {
  id: number
  name: string
  email: string
  emailVerified: boolean
  image: string | null
  [key: string]: unknown
}

export interface AuthSession {
  id: number
  userId: number
  expiresAt: Date
  [key: string]: unknown
}

export interface AuthInstance {
  handler(request: Request): Promise<Response>
  api: {
    getSession(input: { headers: Headers; query?: { disableCookieCache: boolean } }): Promise<{
      user: Pick<AuthUser, 'name' | 'email' | 'emailVerified' | 'image'> & {
        id: string | number
        [key: string]: unknown
      }
      session: unknown
    } | null>
    createUser(input: {
      headers: Headers
      body: {
        name: string
        email: string
        password?: string
        role?: string | string[]
        data?: Record<string, unknown>
      }
      asResponse: true
    }): Promise<Response>
    adminUpdateUser(input: {
      headers: Headers
      body: {
        userId: string
        data: {
          name?: string
          email?: string
          emailVerified?: boolean
          image?: string | null
          role?: string | string[]
        }
      }
      asResponse: true
    }): Promise<Response>
    removeUser(input: {
      headers: Headers
      body: { userId: string }
      asResponse: true
    }): Promise<Response>
  }
}
