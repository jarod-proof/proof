import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import { useReauthGuard } from "../components/reauth-dialog"
import { messageOf } from "../lib/messages"
import type { OrgSettingsApi } from "../lib/org-settings-api"
import { runKeys } from "../lib/run-keys"
import { isLiveStatus } from "../lib/run-view"
import { useRunPolling } from "../lib/use-run-polling"
import type { RunsApi } from "../lib/runs-api"
import type { WebAuth, WebOrganization } from "../lib/web-auth"
import { WebError } from "../lib/web-auth"
import { RunViewPage, type RunViewState } from "../pages/run-view-page"
import type { RenderLink } from "@proof/ui/dplus/shell/link"
import { memberRoleQuery, useSessionQuery } from "./shell-data"

// The permissions the server checks (the catalog in packages/auth/src/access.ts). The page reads them
// from the same catalog, so the controls agree with the server; the server still refuses anything else.
const APPROVE = { run: ["approve"] }
const STEER = { run: ["steer"] }

export interface RunViewContainerProps {
  auth: WebAuth
  api: RunsApi
  settings: Pick<OrgSettingsApi, "roleAllows">
  organization: WebOrganization
  runId: string
  renderLink?: RenderLink
}

/**
 * The run view's data: the run (polled while it is live, paused in the background), the decisions,
 * undo, steering and deferring. Every call names the organization, and a run of another organization
 * reads as not found.
 */
export function RunViewContainer({
  auth,
  api,
  settings,
  organization,
  runId,
  renderLink,
}: RunViewContainerProps) {
  const queryClient = useQueryClient()
  const organizationId = organization.id
  // Deciding and undoing an approval need a recent sign-in (SESSION_NOT_FRESH otherwise).
  const guard = useReauthGuard()
  const role = useQuery(memberRoleQuery(auth, organizationId))
  const session = useSessionQuery(auth)
  const roleText = role.data ?? ""
  const allows = (permissions: Record<string, string[]>) =>
    role.isSuccess && settings.roleAllows(roleText, permissions)
  const canApprove = allows(APPROVE)
  const canSteer = allows(STEER)

  const run = useQuery({
    queryKey: runKeys.detail(organizationId, runId),
    queryFn: () => api.get(organizationId, runId),
    retry: (count, error) => !(error instanceof WebError && error.status === 404) && count < 2,
  })

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: runKeys.detail(organizationId, runId) })
    void queryClient.invalidateQueries({ queryKey: runKeys.lists(organizationId) })
    void queryClient.invalidateQueries({ queryKey: runKeys.inbox(organizationId) })
  }, [organizationId, runId, queryClient])

  // Live runs refresh through Pacer (see use-run-polling): paused when the tab is hidden, stopped once
  // the run has finished. Until the first answer, the run counts as live; a run that is not found or
  // failed to load is not polled (every refetch is metered), and Try again refetches it.
  const polling = run.data ? isLiveStatus(run.data.status) : !run.isError
  const { refetch } = run
  const refetchRun = useCallback(() => {
    void refetch()
  }, [refetch])
  useRunPolling({ live: polling, refresh: refetchRun })

  const [actionError, setActionError] = useState<string | null>(null)
  const onActionError = (error: unknown) => setActionError(messageOf(error))

  const decide = useMutation({
    mutationFn: (input: { approvalId: string; decision: "approve" | "deny" }) =>
      guard(() => api.decide(organizationId, input.approvalId, input.decision)),
    onMutate: () => setActionError(null),
    onError: onActionError,
    onSettled: refresh,
  })

  const undo = useMutation({
    mutationFn: (approvalId: string) => guard(() => api.undo(organizationId, approvalId)),
    onMutate: () => setActionError(null),
    // A refused undo means the window has passed: the decision stands, so show the server's answer.
    onError: onActionError,
    onSettled: refresh,
  })

  const steer = useMutation({
    mutationFn: (body: string) => api.steer(organizationId, runId, body),
    onSuccess: () => setActionError(null),
    onSettled: refresh,
  })

  const defer = useMutation({
    mutationFn: (untilIso: string) => api.defer(organizationId, runId, untilIso),
    onSuccess: () => setActionError(null),
    onSettled: refresh,
  })

  // Once an undo window closes on the clock, the final decision is read from the server.
  const onWindowPassed = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: runKeys.detail(organizationId, runId) })
  }, [organizationId, runId, queryClient])

  const state: RunViewState = useMemo(() => {
    if (run.data) return { kind: "ready", run: run.data }
    if (run.isError) {
      if (run.error instanceof WebError && run.error.status === 404) return { kind: "not-found" }
      return { kind: "error", message: messageOf(run.error) }
    }
    return { kind: "loading" }
  }, [run.data, run.isError, run.error])

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

  const busy = decide.isPending || undo.isPending

  return (
    <RunViewPage
      organization={organization}
      state={state}
      canApprove={canApprove}
      viewerId={session.data?.user.id}
      canSteer={canSteer}
      busy={busy}
      sending={steer.isPending || defer.isPending}
      actionError={actionError}
      onRetry={() => void run.refetch()}
      onDecide={(approvalId, decision) => decide.mutate({ approvalId, decision })}
      onUndo={(approvalId) => undo.mutate(approvalId)}
      onWindowPassed={onWindowPassed}
      onSteer={(body) => steer.mutateAsync(body).then(() => undefined)}
      onDefer={(untilIso) => defer.mutateAsync(untilIso).then(() => undefined)}
      renderLink={renderLink}
    />
  )
}
