import type { ClientOptions } from './index.js'
import { sessionRequest } from './request.js'

export interface Organization {
  id: number
  name: string
  slug: string
  logo: string | null
  metadata?: Record<string, unknown> | null
  createdAt: string
}

export interface OrganizationMember {
  id: number
  organizationId: number
  userId: number
  role: string
  createdAt: string
  user?: { id: number; name: string; email: string; image: string | null }
}

export interface OrganizationInvitation {
  id: number
  organizationId: number
  email: string
  role: string | null
  status: string
  inviterId: number
  expiresAt: string
  createdAt: string
}

export interface OrganizationClient {
  list(): Promise<Organization[]>
  create(input: {
    name: string
    slug: string
    logo?: string | null
    metadata?: Record<string, unknown>
    keepCurrentActiveOrganization?: boolean
  }): Promise<Organization>
  checkSlug(slug: string): Promise<boolean>
  setActive(organizationId: number | null): Promise<Organization | null>
  getFull(organizationId?: number): Promise<
    Organization & {
      members: OrganizationMember[]
      invitations: OrganizationInvitation[]
    }
  >
  update(
    organizationId: number,
    data: Partial<Pick<Organization, 'name' | 'slug' | 'logo' | 'metadata'>>,
  ): Promise<Organization>
  delete(organizationId: number): Promise<void>
  inviteMember(input: {
    email: string
    role: string | string[]
    organizationId?: number
    resend?: boolean
  }): Promise<OrganizationInvitation>
  cancelInvitation(invitationId: number): Promise<void>
  removeMember(memberIdOrEmail: number | string, organizationId?: number): Promise<void>
  updateMemberRole(
    memberId: number,
    role: string | string[],
    organizationId?: number,
  ): Promise<void>
  leave(organizationId: number): Promise<void>
}

/** Typed facade over Better Auth's organization plugin endpoints. */
export function createOrganizationClient(options: ClientOptions = {}): OrganizationClient {
  const { json, post } = sessionRequest(options, '/api/auth')

  function organization(value: Organization): Organization {
    return { ...value, id: Number(value.id) }
  }

  return {
    async list() {
      return (await json<Organization[]>('/organization/list')).map(organization)
    },
    async create(input) {
      return organization(await post<Organization>('/organization/create', input))
    },
    async checkSlug(slug) {
      const result = await post<{ status: boolean }>('/organization/check-slug', { slug })
      return result.status
    },
    async setActive(organizationId) {
      const result = await post<Organization | null>('/organization/set-active', {
        organizationId: organizationId === null ? null : String(organizationId),
      })
      return result ? organization(result) : null
    },
    async getFull(organizationId) {
      const query =
        organizationId === undefined
          ? ''
          : `?organizationId=${encodeURIComponent(String(organizationId))}`
      const result = await json<
        Organization & {
          members: OrganizationMember[]
          invitations: OrganizationInvitation[]
        }
      >(`/organization/get-full-organization${query}`)
      return {
        ...organization(result),
        members: result.members.map((member) => ({
          ...member,
          id: Number(member.id),
          organizationId: Number(member.organizationId),
          userId: Number(member.userId),
          ...(member.user ? { user: { ...member.user, id: Number(member.user.id) } } : {}),
        })),
        invitations: result.invitations.map((invitation) => ({
          ...invitation,
          id: Number(invitation.id),
          organizationId: Number(invitation.organizationId),
          inviterId: Number(invitation.inviterId),
        })),
      }
    },
    async update(organizationId, data) {
      return organization(
        await post<Organization>('/organization/update', {
          organizationId: String(organizationId),
          data,
        }),
      )
    },
    async delete(organizationId) {
      await post('/organization/delete', { organizationId: String(organizationId) })
    },
    async inviteMember(input) {
      const result = await post<OrganizationInvitation>('/organization/invite-member', {
        ...input,
        ...(input.organizationId === undefined
          ? {}
          : { organizationId: String(input.organizationId) }),
      })
      return {
        ...result,
        id: Number(result.id),
        organizationId: Number(result.organizationId),
        inviterId: Number(result.inviterId),
      }
    },
    async cancelInvitation(invitationId) {
      await post('/organization/cancel-invitation', { invitationId: String(invitationId) })
    },
    async removeMember(memberIdOrEmail, organizationId) {
      await post('/organization/remove-member', {
        memberIdOrEmail: String(memberIdOrEmail),
        ...(organizationId === undefined ? {} : { organizationId: String(organizationId) }),
      })
    },
    async updateMemberRole(memberId, role, organizationId) {
      await post('/organization/update-member-role', {
        memberId: String(memberId),
        role,
        ...(organizationId === undefined ? {} : { organizationId: String(organizationId) }),
      })
    },
    async leave(organizationId) {
      await post('/organization/leave', { organizationId: String(organizationId) })
    },
  }
}
