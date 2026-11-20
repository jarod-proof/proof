import type { PinnedAgent } from "@proof/ui/dplus/shell/app-sidebar"
import { useMemo } from "react"
import type { OrgRole, OrgSummary } from "@proof/ui/dplus/shell/org-picker"
import {
  type QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { workspaceAgentKeys } from "../lib/agent-keys"
import { shownRoleOf } from "../lib/members"
import { qk } from "../lib/query-keys"
import { ROLE_LABEL } from "../lib/roles"
import { pinnedAgentsOf } from "../lib/workspace-agents"
import type { WorkspaceAgentsApi } from "../lib/workspace-agents-api"
import type { WebAuth, WebOrganization, WebSession } from "../lib/web-auth"

// Query functions are plain objects so the route guards and the containers share one definition
// (the guards call `ensureQueryData`, the containers call `useQuery`).

export const sessionQuery = (auth: WebAuth) => ({
  queryKey: qk.session(),
  queryFn: () => auth.getSession(),
})

export const organizationsQuery = (auth: WebAuth) => ({
  queryKey: qk.organizations(),
  queryFn: () => auth.listOrganizations(),
})

export const memberRoleQuery = (auth: WebAuth, organizationId: string) => ({
  queryKey: qk.org(organizationId).role(),
  queryFn: () => auth.memberRole(organizationId),
})

export function useSessionQuery(auth: WebAuth) {
  return useQuery(sessionQuery(auth))
}

export function useOrganizationsQuery(auth: WebAuth) {
  return useQuery(organizationsQuery(auth))
}

/** Each organization's role for the caller, keyed by organization id. Roles load one org at a time. */
export function useMemberRoles(auth: WebAuth, organizations: WebOrganization[] | undefined) {
  const results = useQueries({
    queries: (organizations ?? []).map((org) => memberRoleQuery(auth, org.id)),
  })
  const roles = new Map<string, string>()
  ;(organizations ?? []).forEach((org, index) => {
    const role = results[index]?.data
    if (role !== undefined) roles.set(org.id, role)
  })
  return roles
}

/** Make `organizationId` the session's active organization. Always passes the id explicitly. */
export function useSetActiveOrganization(auth: WebAuth) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (organizationId: string) => auth.setActiveOrganization(organizationId),
    onSuccess: () => invalidateSession(queryClient),
  })
}

export function useSignOut(auth: WebAuth) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => auth.signOut(),
    // Nothing from the signed-in session may stay cached for the next person on this browser.
    // reset, not clear: clear drops the queries without telling mounted components, which keep
    // showing what they last had. Not awaited: the caller's onSuccess (the way to /sign-in) runs
    // after this, and must not wait for the page's queries to fail as signed out.
    onSettled: () => {
      void queryClient.resetQueries()
    },
  })
}

export function invalidateSession(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: qk.session() })
}

/**
 * A membership's role string ("owner", "admin,member") as the picker's label: the role the members
 * list shows for it (shownRoleOf). A role we don't know yet is shown as Viewer: the least it can
 * be, and the server still decides what the person may do.
 */
export function orgRoleLabel(role: string | undefined): OrgRole {
  return ROLE_LABEL[shownRoleOf(role ?? "")]
}

export function toOrgSummaries(
  organizations: WebOrganization[],
  roles: Map<string, string>,
): OrgSummary[] {
  return organizations.map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    role: orgRoleLabel(roles.get(org.id)),
    ...(org.logo ? { logo: org.logo } : {}),
  }))
}

/** The session's active organization, if it is one of the caller's. */
export function activeOrganization(
  session: WebSession | null | undefined,
  organizations: WebOrganization[] | undefined,
): WebOrganization | undefined {
  const id = session?.activeOrganizationId
  if (!id) return undefined
  return organizations?.find((org) => org.id === id)
}

/**
 * The sidebar's pinned agents, from the organization's workspace agents. Waits until the session's
 * active organization is this one: the server answers a call for another org with 409.
 */
export function usePinnedAgents({
  api,
  organizationId,
  slug,
  ready,
}: {
  api: WorkspaceAgentsApi | undefined
  organizationId: string | null
  slug: string | null
  ready: boolean
}): PinnedAgent[] {
  const query = useQuery({
    queryKey: organizationId
      ? workspaceAgentKeys.list(organizationId)
      : ["workspace-agents", "none"],
    queryFn: () => api?.list(organizationId ?? "") ?? Promise.resolve([]),
    enabled: Boolean(api && organizationId && slug && ready),
  })
  return useMemo(() => pinnedAgentsOf(query.data ?? [], slug ?? ""), [query.data, slug])
}
