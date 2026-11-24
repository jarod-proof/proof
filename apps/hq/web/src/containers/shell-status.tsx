import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"

import { hqKeys } from "../api/query-keys"
import type { FactoryStatus } from "../api/schemas"
import { RunnerCard } from "../components/runner-card"
import { Sidebar } from "../components/sidebar"
import { type NavKey, NAV_ITEMS } from "../lib/nav"
import { useHq } from "../lib/use-hq"

/** How often the sidebar asks hq again, while the tab is visible (a hidden tab does not poll). */
export const STATUS_POLL_MS = 30_000

/**
 * What waits for a founder on Approvals: the pending proposals plus what the pipeline waits on
 * (`work.needsYou`). `work` is null before hq's work tables exist and absent from an older hq:
 * both count 0, so the badge is the proposals alone. Nothing before the first read.
 */
function approvalsBadge(status: FactoryStatus | undefined): number | undefined {
  return status === undefined ? undefined : status.pendingProposals + (status.work?.needsYou ?? 0)
}

/**
 * The live sidebar: the nav badge and the runner card both read `get_factory_status`. A failed
 * call only puts the runner card in its error state; the nav keeps working and shows no badge.
 */
export function ShellStatus({
  activeKey,
  account,
}: {
  activeKey: NavKey | null
  account: ReactNode
}) {
  const { client } = useHq()
  const status = useQuery({
    queryKey: hqKeys.factoryStatus(),
    queryFn: () => client.getFactoryStatus(),
    refetchInterval: STATUS_POLL_MS,
  })
  // A refetch that failed keeps the last good data on screen; only a first failure is an error.
  const state = status.data ? "ready" : status.isError ? "error" : "loading"
  return (
    <Sidebar
      items={NAV_ITEMS}
      activeKey={activeKey}
      badges={{ pendingProposals: approvalsBadge(status.data) }}
      runner={<RunnerCard status={status.data} state={state} />}
      account={account}
    />
  )
}
