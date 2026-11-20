import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useCallback, useMemo } from "react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"

import { workspaceAgentKeys } from "../lib/agent-keys"
import { messageOf } from "../lib/messages"
import { qk } from "../lib/query-keys"
import type { OrgSettingsApi } from "../lib/org-settings-api"
import type {
  AgentPatch,
  CreateAgentInput,
  WorkspaceAgent,
  WorkspaceAgentsApi,
} from "../lib/workspace-agents-api"
import type { WebAuth, WebOrganization } from "../lib/web-auth"
import { agentViewOf } from "../lib/workspace-agents"
import { WorkspaceAgentsPage } from "../pages/workspace-agents-page"
import { memberRoleQuery, orgRoleLabel } from "./shell-data"

// The permissions the server checks (the catalog in packages/auth/src/access.ts). The page derives its
// controls from the same catalog, so they agree with the server: members can't delete agents, viewers
// only read them.
const READ = { agent: ["read"] }
const CREATE = { agent: ["create"] }
const UPDATE = { agent: ["update"] }
const DELETE = { agent: ["delete"] }

export interface WorkspaceAgentsContainerProps {
  auth: WebAuth
  api: WorkspaceAgentsApi
  settings: Pick<OrgSettingsApi, "roleAllows">
  organization: WebOrganization
  /** The view from the URL (`?view=`), unchecked until agentViewOf reads it. */
  view: string | undefined
  /** The agent selected in the URL (`?agent=`). Falls back to the first agent. */
  selectedId: string | undefined
  onSelect: (agentId: string | null) => void
  /** The connected-agents view, rendered when `view` is "connected". Gets the level-2 pills. */
  connected: (pills: ReactNode) => ReactNode
  renderLink?: RenderLink
}

/**
 * Data and mutations for the organization's agents settings page. The caller's role decides every
 * control; the server still refuses anything the role may not do. Every call names the organization.
 */
export function WorkspaceAgentsContainer({
  auth,
  api,
  settings,
  organization,
  view,
  selectedId,
  onSelect,
  connected,
  renderLink,
}: WorkspaceAgentsContainerProps) {
  const queryClient = useQueryClient()
  const organizationId = organization.id
  const role = useQuery(memberRoleQuery(auth, organizationId))
  const roleText = role.data ?? ""
  const allows = (permissions: Record<string, string[]>) =>
    role.isSuccess && settings.roleAllows(roleText, permissions)
  const canRead = allows(READ)
  const canCreate = allows(CREATE)
  const canUpdate = allows(UPDATE)
  const canDelete = allows(DELETE)
  const currentView = agentViewOf(view)

  const agents = useQuery({
    queryKey: workspaceAgentKeys.list(organizationId),
    queryFn: () => api.list(organizationId),
    // The budgets tab edits the selected agent too, so it needs the list.
    enabled: canRead && (currentView === "permissions" || currentView === "budgets"),
  })
  const agentRows = useMemo(() => agents.data ?? [], [agents.data])
  const selected = agentRows.find((agent) => agent.id === selectedId) ?? agentRows[0] ?? undefined

  // Only the delete dialog and the consequence line need the count.
  const runCount = useQuery({
    queryKey: workspaceAgentKeys.runCount(organizationId, selected?.id ?? "none"),
    queryFn: () => api.countRuns(organizationId, selected?.id ?? ""),
    enabled: canDelete && canRead && currentView === "permissions" && Boolean(selected),
  })

  const refreshAgents = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workspaceAgentKeys.list(organizationId) })
  }, [organizationId, queryClient])

  const createMutation = useMutation({
    mutationFn: (input: CreateAgentInput) => api.create(organizationId, input),
    onSuccess: (created) => {
      refreshAgents()
      onSelect(created.id)
    },
  })

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; patch: AgentPatch }) =>
      api.update(organizationId, input.id, input.patch),
    onSuccess: (updated) => {
      queryClient.setQueryData<WorkspaceAgent[]>(
        workspaceAgentKeys.list(organizationId),
        (current) => current?.map((agent) => (agent.id === updated.id ? updated : agent)),
      )
      refreshAgents()
    },
  })

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.remove(organizationId, id),
    onSuccess: (_result, id) => {
      refreshAgents()
      // Its runs are gone too: the run lists and the counts for them are stale.
      void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).runs() })
      queryClient.removeQueries({ queryKey: workspaceAgentKeys.runCount(organizationId, id) })
    },
  })

  if (role.isError) {
    return (
      <p role="alert" className="p-6 text-destructive">
        Could not load your role in this organization.
      </p>
    )
  }
  if (!role.isSuccess) {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }

  const mutationError = [createMutation, updateMutation, removeMutation]
    .map((mutation) => (mutation.isError ? mutation.error : null))
    .find((error) => error !== null)

  return (
    <WorkspaceAgentsPage
      organization={organization}
      roleLabel={orgRoleLabel(roleText)}
      view={currentView}
      connected={connected}
      canRead={canRead}
      canCreate={canCreate}
      canUpdate={canUpdate}
      canDelete={canDelete}
      agents={canRead ? agents.data : undefined}
      agentsPending={canRead && agents.isPending}
      agentsError={canRead && agents.isError ? messageOf(agents.error) : null}
      onRetry={() => void agents.refetch()}
      selected={selected}
      runCount={canDelete ? runCount.data : undefined}
      actionError={mutationError ? messageOf(mutationError) : null}
      onSelect={onSelect}
      onCreate={(input) => createMutation.mutateAsync(input).then(() => undefined)}
      onUpdate={(id, patch) => updateMutation.mutateAsync({ id, patch }).then(() => undefined)}
      onRemove={(id) => removeMutation.mutateAsync(id).then(() => undefined)}
      renderLink={renderLink}
    />
  )
}
