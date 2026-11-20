import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"

import { useReauthGuard } from "../components/reauth-dialog"
import { messageOf } from "../lib/messages"

import {
  type Allows,
  type AssignableRole,
  CANCEL_INVITATION,
  INVITE_PERMISSION,
  SEE_SECURITY,
  canChangeRole,
  canRemoveMember,
  canResetTwoFactor,
  initialsOf,
  invitationState,
  permissionMatrix,
  roleLabelOf,
} from "../lib/members"
import type { MembersApi, MemberSecurity, OrgInvitation } from "../lib/members-api"
import { defaultInviteRoleOf } from "../lib/org-settings"
import { type OrgSettingsApi } from "../lib/org-settings-api"
import { qk } from "../lib/query-keys"
import type { OrgRole } from "../lib/roles"
import type { WebAuth, WebOrganization } from "../lib/web-auth"
import {
  type InviteOutcome,
  type InvitationView,
  type MemberView,
  MembersPage,
} from "../pages/members-page"
import { invalidateSession, memberRoleQuery, orgRoleLabel, useSessionQuery } from "./shell-data"

export interface MembersContainerProps {
  auth: WebAuth
  api: OrgSettingsApi
  membersApi: MembersApi
  organization: WebOrganization
  renderLink?: RenderLink
  /** For tests: the clock the copy is written against. */
  now?: Date
}

/**
 * Data and mutations for the organization's Members page. The caller's role decides what the page
 * offers: invitations need invitation:create, the security columns need member:read, and each row
 * control is derived from the plugin's own permission check.
 */
export function MembersContainer({
  auth,
  api,
  membersApi,
  organization,
  renderLink,
  now,
}: MembersContainerProps) {
  const queryClient = useQueryClient()
  // Inviting, changing a role, removing a member and resetting two-factor need a recent sign-in.
  const guard = useReauthGuard()
  const organizationId = organization.id
  const session = useSessionQuery(auth)
  const role = useQuery(memberRoleQuery(auth, organizationId))
  const roleText = role.data ?? ""
  const allows: Allows = (permission) => role.isSuccess && api.roleAllows(roleText, permission)
  const canInvite = allows(INVITE_PERMISSION)
  const showSecurity = allows(SEE_SECURITY)
  const canSeeInvitations = allows(CANCEL_INVITATION) || canInvite

  const settings = useQuery({
    queryKey: qk.org(organizationId).settings(),
    queryFn: () => api.getOrganization(organizationId),
    enabled: role.isSuccess,
  })
  const members = useQuery({
    queryKey: qk.org(organizationId).members(),
    queryFn: () => api.listMembers(organizationId),
    enabled: role.isSuccess,
  })
  // Under the members prefix, so a role change or removal refreshes both lists.
  const security = useQuery({
    queryKey: qk.org(organizationId).membersSecurity(),
    queryFn: () => membersApi.listSecurity(organizationId),
    enabled: role.isSuccess && showSecurity,
  })
  const invitations = useQuery({
    queryKey: qk.org(organizationId).invitations(),
    queryFn: () => membersApi.listInvitations(organizationId),
    enabled: role.isSuccess && canSeeInvitations,
  })

  const securityByUser = useMemo(() => {
    const map = new Map<string, MemberSecurity>()
    for (const row of security.data ?? []) map.set(row.userId, row)
    return map
  }, [security.data])

  const refreshMembers = () => {
    void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).members() })
    void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).counts() })
  }

  const invite = useMutation({
    mutationFn: async (input: { emails: string[]; role: AssignableRole }) => {
      const failed: InviteOutcome["failed"] = []
      // One call per address: better-auth invites one email at a time.
      for (const email of input.emails) {
        try {
          await guard(() => membersApi.invite(organizationId, { email, role: input.role }))
        } catch (caught) {
          failed.push({ email, message: caught instanceof Error ? caught.message : "Failed" })
        }
      }
      return { failed }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).invitations() })
    },
  })

  const changeRole = useMutation({
    mutationFn: async (input: { member: MemberView; role: AssignableRole }) => {
      await guard(() => api.updateMemberRole(organizationId, input.member.id, input.role))
    },
    onSuccess: (_data, input) => {
      refreshMembers()
      // The caller's own role may have changed; re-read it through the shell.
      if (input.member.isSelf) {
        void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).role() })
        void invalidateSession(queryClient)
      }
    },
  })

  const remove = useMutation({
    mutationFn: (member: MemberView) =>
      guard(() => membersApi.removeMember(organizationId, member.id)),
    onSuccess: () => refreshMembers(),
  })

  const resetTwoFactor = useMutation({
    mutationFn: (member: MemberView) =>
      guard(() => membersApi.resetTwoFactor(organizationId, member.userId)),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: qk.org(organizationId).membersSecurity(),
      })
    },
  })

  const resend = useMutation({
    mutationFn: (invitation: InvitationView) =>
      guard(() =>
        membersApi.invite(organizationId, {
          email: invitation.email,
          role: invitation.role,
          resend: true,
        }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).invitations() })
    },
  })

  const cancel = useMutation({
    mutationFn: (invitation: InvitationView) => membersApi.cancelInvitation(invitation.id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).invitations() })
    },
  })

  if (role.isError) {
    return (
      <p role="alert" className="p-6 text-destructive">
        Could not load your role in this organization.
      </p>
    )
  }
  if (!role.isSuccess || !settings.isSuccess || !members.isSuccess) {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }
  if (showSecurity && security.isError) {
    return (
      <p role="alert" className="p-6 text-destructive">
        Could not load the members' security state.
      </p>
    )
  }

  const selfUserId = session.data?.user.id
  const memberRows: MemberView[] = (members.data?.members ?? []).map((member) => {
    const isSelf = member.userId === selfUserId
    const sec = securityByUser.get(member.userId)
    const view = {
      id: member.id,
      userId: member.userId,
      name: member.name,
      email: member.email,
      initials: initialsOf(member.name, member.email),
      role: member.role,
      roleLabel: roleLabelOf(member.role),
      isSelf,
    }
    const abilities = { isSelf, role: member.role, twoFactorEnabled: sec?.twoFactorEnabled }
    return {
      ...view,
      canChangeRole: canChangeRole(abilities, allows),
      canRemove: canRemoveMember(abilities, allows),
      canResetTwoFactor: canResetTwoFactor(abilities, allows),
      twoFactorEnabled: showSecurity ? (sec?.twoFactorEnabled ?? undefined) : undefined,
      lastActiveAt: showSecurity ? sec?.lastActiveAt : undefined,
    }
  })

  const clock = now ?? new Date()
  const invitationRows: InvitationView[] | undefined = canSeeInvitations
    ? (invitations.data ?? [])
        .filter((invitation: OrgInvitation) => invitation.status === "pending")
        .map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          roleLabel: roleLabelOf(invitation.role),
          expired: invitationState(invitation.expiresAt, clock) === "expired",
          createdAt: invitation.createdAt,
          expiresAt: invitation.expiresAt,
        }))
    : undefined

  const matrix = permissionMatrix((matrixRole: OrgRole, permission) =>
    api.roleAllows(matrixRole, permission),
  )

  return (
    <MembersPage
      organization={{ id: organizationId, name: organization.name, slug: organization.slug }}
      roleLabel={orgRoleLabel(roleText)}
      canInvite={canInvite}
      showSecurity={showSecurity}
      invitations={invitationRows}
      invitationsError={invitations.isError ? messageOf(invitations.error) : null}
      defaultInviteRole={defaultInviteRoleOf(settings.data?.metadata)}
      members={memberRows}
      matrix={matrix}
      now={now}
      onInvite={(emails, inviteRole) => invite.mutateAsync({ emails, role: inviteRole })}
      onChangeRole={async (member, next) => {
        await changeRole.mutateAsync({ member, role: next })
      }}
      onRemove={async (member) => {
        await remove.mutateAsync(member)
      }}
      onResetTwoFactor={async (member) => {
        await resetTwoFactor.mutateAsync(member)
      }}
      onResend={async (invitation) => {
        await resend.mutateAsync(invitation)
      }}
      onCancel={async (invitation) => {
        await cancel.mutateAsync(invitation)
      }}
      renderLink={renderLink}
    />
  )
}
