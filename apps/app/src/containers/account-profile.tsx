import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"

import type { AccountApi } from "../lib/account-api"
import { isOwnerRole, personalSlugOf } from "../lib/account-format"
import { accountKeys } from "../lib/account-keys"
import { useReauthGuard } from "../components/reauth-dialog"
import type { OrgSettingsApi } from "../lib/org-settings-api"
import { qk } from "../lib/query-keys"
import type { UploadsApi } from "../lib/uploads-api"
import type { WebAuth } from "../lib/web-auth"
import {
  invalidateSession,
  orgRoleLabel,
  useMemberRoles,
  useOrganizationsQuery,
} from "./shell-data"
import { type AccountOrganization, AccountProfilePage } from "../pages/account-profile-page"

export interface AccountProfileContainerProps {
  auth: WebAuth
  api: AccountApi
  orgApi: Pick<OrgSettingsApi, "leaveOrganization">
  renderLink?: RenderLink
  /** Avatar uploads. */
  uploads: UploadsApi
}

/**
 * Data and mutations for the account profile page. The organizations come from the shell's list and
 * the caller's role in each; deletion is refused by the server while the person owns an organization
 * others depend on, and the page shows that from the same roles before anything is sent.
 */
export function AccountProfileContainer({
  auth,
  api,
  orgApi,
  renderLink,
  uploads,
}: AccountProfileContainerProps) {
  const queryClient = useQueryClient()
  // Changing the email and deleting the account need a recent sign-in (SESSION_NOT_FRESH otherwise).
  const guard = useReauthGuard()
  const profile = useQuery({
    queryKey: accountKeys.profile(),
    queryFn: () => api.getProfile(),
  })
  // A failure to ask reads as "off": the page still works, with the buttons disabled.
  const uploadLimits = useQuery({ queryKey: qk.uploadLimits(), queryFn: () => uploads.limits() })
  const organizations = useOrganizationsQuery(auth)
  const roles = useMemberRoles(auth, organizations.data)

  // Local to this visit: the server keeps no record of a pending change, so a reload clears it.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const [deleteRequestedTo, setDeleteRequestedTo] = useState<string | null>(null)

  if (profile.isError) {
    return (
      <p role="alert" className="p-6 text-destructive">
        Could not load your account. Reload the page to try again.
      </p>
    )
  }
  if (!profile.isSuccess || !organizations.isSuccess) {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }

  const me = profile.data
  const personalSlug = personalSlugOf(me.id)
  const rows: AccountOrganization[] = organizations.data.map((org) => {
    const role = roles.get(org.id) ?? ""
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      roleLabel: orgRoleLabel(role),
      personal: org.slug === personalSlug,
      owner: isOwnerRole(role),
    }
  })

  const refreshAccount = () => {
    void queryClient.invalidateQueries({ queryKey: accountKeys.profile() })
    void invalidateSession(queryClient)
  }

  return (
    <AccountProfilePage
      profile={{
        name: me.name,
        email: me.email,
        emailVerified: me.emailVerified,
        image: me.image ?? null,
      }}
      avatar={{
        limits: uploadLimits.data?.enabled ? uploadLimits.data : null,
        onUpload: async (file) => {
          await uploads.setAvatar(file)
          refreshAccount()
        },
        onRemove: async () => {
          await uploads.removeAvatar()
          refreshAccount()
        },
      }}
      pendingEmail={pendingEmail}
      deleteRequestedTo={deleteRequestedTo}
      organizations={rows}
      rolesReady={rows.every((row) => roles.has(row.id))}
      renderLink={renderLink}
      onSaveName={async (name) => {
        await api.updateName(name)
        refreshAccount()
      }}
      onChangeEmail={async (newEmail) => {
        await guard(() => api.changeEmail(newEmail, "/account/profile"))
        setPendingEmail(newEmail)
      }}
      onResendChange={async () => {
        if (!pendingEmail) return
        await guard(() => api.changeEmail(pendingEmail, "/account/profile"))
      }}
      onCancelChange={() => setPendingEmail(null)}
      onLeave={async (organizationId) => {
        await orgApi.leaveOrganization(organizationId)
        void queryClient.invalidateQueries({ queryKey: qk.organizations() })
        void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).all() })
        void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).role() })
        void invalidateSession(queryClient)
      }}
      onRequestDelete={async () => {
        await guard(() => api.requestAccountDeletion("/account/profile"))
        setDeleteRequestedTo(me.email)
      }}
    />
  )
}
