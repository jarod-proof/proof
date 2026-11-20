import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useMemo } from "react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"

import { type GeneralValues, OrgGeneralPage } from "../pages/org-general-page"
import { defaultInviteRoleOf, ownerCount, withDefaultInviteRole } from "../lib/org-settings"
import { type OrgSettingsApi, type OrgSettings } from "../lib/org-settings-api"
import { getWorkspaceAgentsApi, type WorkspaceAgentsApi } from "../lib/workspace-agents-api"
import { qk } from "../lib/query-keys"
import type { UploadsApi } from "../lib/uploads-api"
import type { WebAuth, WebOrganization } from "../lib/web-auth"
import { orgRoleLabel, invalidateSession, memberRoleQuery, useSessionQuery } from "./shell-data"

/** The permission checks the page's controls are derived from (the catalog, via the plugin). */
const EDIT = { organization: ["update"] }
const OWNER_ONLY = { organization: ["delete"] }

export interface OrgGeneralContainerProps {
  auth: WebAuth
  api: OrgSettingsApi
  organization: WebOrganization
  /** The app's host, for the URL prefix. */
  host: string
  /** The slug changed: go to the new address (the page unmounts). */
  onSlugChanged: (slug: string) => void
  /** Left or deleted: go to another organization's page, or null for /new. */
  onExit: (nextSlug: string | null) => void
  renderLink?: RenderLink
  /** Workspace agents, for the deletion count. Defaults to the app's API. */
  agentsApi?: Pick<WorkspaceAgentsApi, "list">
  /** Logo uploads. */
  uploads: UploadsApi
}

/**
 * Data and mutations for the organization's General page. Every call names the organization; the
 * caller's role decides what the page allows, through the plugin's own permission check.
 */
export function OrgGeneralContainer({
  auth,
  api,
  organization,
  host,
  onSlugChanged,
  onExit,
  renderLink,
  agentsApi = getWorkspaceAgentsApi(),
  uploads,
}: OrgGeneralContainerProps) {
  const queryClient = useQueryClient()
  const organizationId = organization.id
  const session = useSessionQuery(auth)
  const role = useQuery(memberRoleQuery(auth, organizationId))
  const roleText = role.data ?? ""
  const canEdit = role.isSuccess && api.roleAllows(roleText, EDIT)
  const isOwner = role.isSuccess && api.roleAllows(roleText, OWNER_ONLY)

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
  const agents = useQuery({
    queryKey: qk.org(organizationId).agentsCount(),
    queryFn: async () => (await agentsApi.list(organizationId)).length,
    enabled: isOwner,
  })
  const apiKeys = useQuery({
    queryKey: qk.org(organizationId).counts(),
    queryFn: () => api.countApiKeys(organizationId),
    enabled: isOwner,
  })

  // A failure to ask reads as "off": the page still works, with the upload disabled.
  const uploadLimits = useQuery({
    queryKey: qk.uploadLimits(),
    queryFn: () => uploads.limits(),
    enabled: canEdit,
  })
  /** After the logo changed: the page and the shell's organization list both show it. */
  const logoChanged = () => {
    void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).settings() })
    void queryClient.invalidateQueries({ queryKey: qk.organizations() })
  }

  // Stable: the page's availability check re-runs whenever this identity changes.
  const checkSlugFor = useCallback((slug: string) => auth.checkSlug(slug), [auth])

  const memberRows = useMemo(() => members.data?.members ?? [], [members.data])
  const admins = memberRows
    .filter((member) =>
      member.role
        .split(",")
        .map((r) => r.trim())
        .includes("admin"),
    )
    .map((member) => ({
      memberId: member.id,
      label: member.name || member.email || member.userId,
    }))

  const save = useMutation({
    mutationFn: (values: GeneralValues) =>
      api.updateOrganization(organizationId, {
        name: values.name,
        slug: values.slug,
        metadata: withDefaultInviteRole(settings.data?.metadata, values.defaultInviteRole),
      }),
    onSuccess: (updated: OrgSettings) => {
      queryClient.setQueryData(qk.org(organizationId).settings(), updated)
      // The shell's list and the URL both read the slug from here, so update it before navigating.
      queryClient.setQueryData<WebOrganization[]>(qk.organizations(), (list) =>
        list?.map((item) =>
          item.id === organizationId ? { ...item, name: updated.name, slug: updated.slug } : item,
        ),
      )
      void queryClient.invalidateQueries({ queryKey: qk.organizations() })
    },
  })

  const transfer = useMutation({
    mutationFn: async (targetMemberId: string) => {
      const self = memberRows.find((member) => member.userId === session.data?.user.id)
      if (!self) throw new Error("Your membership could not be found.")
      // Order matters: the new owner first (the caller is still an owner, so this is allowed), then
      // the caller steps down. Stepping down first would leave no owner. Both carry the organization.
      await api.updateMemberRole(organizationId, targetMemberId, "owner")
      await api.updateMemberRole(organizationId, self.id, "admin")
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).role() })
      void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).members() })
    },
  })

  const leave = useMutation({
    mutationFn: () => api.leaveOrganization(organizationId),
    onSuccess: () => finishExit(),
  })

  const remove = useMutation({
    mutationFn: () => api.deleteOrganization(organizationId),
    onSuccess: () => finishExit(),
  })

  /** After leaving or deleting: drop it from the list, clear the session's pointer, go elsewhere. */
  const finishExit = useCallback(() => {
    const remaining = (
      queryClient.getQueryData<WebOrganization[]>(qk.organizations()) ?? []
    ).filter((item) => item.id !== organizationId)
    queryClient.setQueryData<WebOrganization[]>(qk.organizations(), remaining)
    void invalidateSession(queryClient)
    void queryClient.invalidateQueries({ queryKey: qk.organizations() })
    onExit(remaining[0]?.slug ?? null)
  }, [onExit, organizationId, queryClient])

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

  const current = settings.data
  const saved = {
    name: current.name,
    slug: current.slug,
    role: defaultInviteRoleOf(current.metadata),
  }
  const soleOwner = isOwner && ownerCount(memberRows) <= 1

  return (
    <OrgGeneralPage
      // Remounted when the saved values change, so the form starts again from what the server holds.
      key={`${saved.name}|${saved.slug}|${saved.role}`}
      organization={{ id: organizationId, name: saved.name, slug: saved.slug, logo: current.logo }}
      logoUpload={{
        limits: uploadLimits.data?.enabled ? uploadLimits.data : null,
        onUpload: async (file) => {
          await uploads.setLogo(organizationId, file)
          logoChanged()
        },
        onRemove: async () => {
          await uploads.removeLogo(organizationId)
          logoChanged()
        },
      }}
      host={host}
      roleLabel={orgRoleLabel(roleText)}
      canEdit={canEdit}
      isOwner={isOwner}
      soleOwner={soleOwner}
      defaultInviteRole={saved.role}
      counts={{
        members: members.data?.total,
        apiKeys: apiKeys.data,
        agents: agents.data,
      }}
      admins={admins}
      checkSlug={checkSlugFor}
      onSave={async (values) => {
        const updated = await save.mutateAsync(values)
        if (updated.slug !== saved.slug) onSlugChanged(updated.slug)
      }}
      onTransfer={async (memberId) => {
        await transfer.mutateAsync(memberId)
      }}
      onLeave={async () => {
        await leave.mutateAsync()
      }}
      onDelete={async () => {
        await remove.mutateAsync()
      }}
      renderLink={renderLink}
    />
  )
}
