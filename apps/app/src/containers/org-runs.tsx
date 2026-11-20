import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useMemo } from "react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"

import { useFlag } from "../lib/flags"
import { messageOf } from "../lib/messages"
import { needsYouFirst } from "../lib/run-view"
import { runKeys } from "../lib/run-keys"
import type { RunStatus, RunsApi, RunSummary } from "../lib/runs-api"
import type { WebAuth, WebOrganization } from "../lib/web-auth"
import { OrgHomePage } from "../pages/org-home-page"
import { memberRoleQuery } from "./shell-data"

const PAGE_SIZE = 50

export interface OrgRunsContainerProps {
  auth: WebAuth
  api: RunsApi
  organization: WebOrganization
  /** The filter from the URL (`?status=`). */
  filter: RunStatus | "all"
  renderLink?: RenderLink
}

/** The organization's runs: the needs-you section first, then the list, filtered by status. */
export function OrgRunsContainer({
  auth,
  api,
  organization,
  filter,
  renderLink,
}: OrgRunsContainerProps) {
  // The example flag (packages/flags): the What's new card, for organizations it is on for.
  const whatsNew = useFlag("whats-new-card")
  const queryClient = useQueryClient()
  const organizationId = organization.id
  const role = useQuery(memberRoleQuery(auth, organizationId))

  const list = useInfiniteQuery({
    queryKey: runKeys.list(organizationId, filter),
    queryFn: ({ pageParam }) =>
      api.list(organizationId, {
        status: filter === "all" ? undefined : filter,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: role.isSuccess,
  })

  // The needs-you section is only shown with no filter; it is the list's runs that need a person.
  const needs = useQuery({
    queryKey: runKeys.needsYou(organizationId),
    queryFn: () => api.list(organizationId, { status: "needs_you", limit: PAGE_SIZE }),
    enabled: role.isSuccess && filter === "all",
  })

  const needsRuns: RunSummary[] = useMemo(() => needs.data?.runs ?? [], [needs.data])
  const needsIds = useMemo(() => new Set(needsRuns.map((run) => run.id)), [needsRuns])
  const loaded = useMemo(() => list.data?.pages.flatMap((page) => page.runs) ?? [], [list.data])
  // With no filter, the needs-you runs sit in their own section, so the list leaves them out.
  const runs = useMemo(
    () =>
      filter === "all" ? loaded.filter((run) => !needsIds.has(run.id)) : needsYouFirst(loaded),
    [filter, loaded, needsIds],
  )

  const { fetchNextPage } = list
  // Stable, so the page's scroll effect doesn't re-fire on every render; the page guards repeat calls.
  const loadMore = useCallback(() => {
    void fetchNextPage()
  }, [fetchNextPage])

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

  const failed = list.isError ? list.error : null
  const status = failed ? "error" : list.isPending ? "loading" : "ready"

  return (
    <OrgHomePage
      organization={organization}
      renderLink={renderLink}
      filter={filter}
      whatsNew={whatsNew}
      needsYou={needsRuns}
      runs={runs}
      status={status}
      errorMessage={failed ? messageOf(failed) : null}
      onRetry={() => {
        void queryClient.invalidateQueries({ queryKey: runKeys.lists(organizationId) })
      }}
      hasNextPage={Boolean(list.hasNextPage)}
      loadingMore={list.isFetchingNextPage}
      onLoadMore={loadMore}
    />
  )
}
