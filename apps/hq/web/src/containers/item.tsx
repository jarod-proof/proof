import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"

import { HqError } from "../api/errors"
import { hqKeys } from "../api/query-keys"
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/states"
import { signalLink } from "../lib/signal-link"
import { useHq } from "../lib/use-hq"
import { BUSY_MESSAGE, useOneWrite } from "../lib/use-one-write"
import { type ItemActions, ItemPage } from "../pages/item-page"

const NOT_RECORDED = { kind: "not-recorded" } as const
const sha7 = (sha: string) => sha.slice(0, 7)

const BACK_LINK =
  "inline-flex min-h-touch items-center self-start rounded-control border-2 border-input px-4 text-sm font-bold text-foreground hover:bg-accent"

/** hq has no such item: a mistyped id, or one that is not in this organization. */
function NotFound({ itemRef }: { itemRef: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <EmptyState
        title="Work item not found"
        description={`There is no work item ${itemRef}. The address may be mistyped, or the item is not in this organization.`}
      />
      <Link to="/work" className={BACK_LINK}>
        Back to Work
      </Link>
    </div>
  )
}

/**
 * The Item detail screen. It reads hq's item (and the board, which says how attempts start) and
 * renders them as they are. Every write is sent from a click only, once (a synchronous lock closes
 * the gap before React disables the buttons), never retried, one at a time, and the page is read
 * again before the next one can start. The transcript is "not recorded": Phase 4 has no source.
 */
export function Item({ itemRef }: { itemRef: string }) {
  const { client, queryClient } = useHq()
  const { pending, errors, notice, write } = useOneWrite({ queryClient })
  // The key of the last write that actually took the lock: only its refusal is the page's to show.
  const [lastRan, setLastRan] = useState<string | null>(null)
  // A click was turned away since the write that is on its way took the lock (not `errors`, which
  // keeps a key's busy message until that same control is used again).
  const [turnedAway, setTurnedAway] = useState(false)

  const item = useQuery({
    queryKey: hqKeys.workItem(itemRef),
    queryFn: () => client.getWorkItem({ itemId: itemRef }),
  })
  // How attempts start is the board's fact; the item does not carry it.
  const board = useQuery({ queryKey: hqKeys.workBoard(), queryFn: () => client.getWorkBoard() })
  const session = useQuery({ queryKey: hqKeys.session(), queryFn: () => client.session() })

  const data = item.data
  if (data === undefined) {
    if (item.isError) {
      const error =
        item.error instanceof HqError
          ? item.error
          : new HqError({ kind: "server", status: 0, message: "unexpected" })
      // A reference hq cannot read (400) is as good as one it does not have (404).
      if (error.kind === "not-found" || error.kind === "bad-request") {
        return <NotFound itemRef={itemRef} />
      }
      return <ErrorBlock error={error} onRetry={() => void item.refetch()} />
    }
    return <LoadingBlock label="the work item" />
  }

  const itemId = data.id
  const label = data.displayId
  const run = (key: string, send: () => Promise<string>) => {
    void write(key, send).then((ran) => {
      // A click turned away settles before the write that took the lock; that write's own end
      // (ran) then clears the flag, so it belongs to one write and never outlives it.
      setTurnedAway(!ran)
      if (ran) setLastRan(key)
    })
  }
  // While a write is on its way the page says only that a second click was turned away; after it,
  // the refusal of the key that actually ran. "Another change is in flight" is true only while it
  // is: a second click on the same button (before the lock opens again) leaves it in `errors`.
  const ranError = lastRan === null ? null : (errors[lastRan] ?? null)
  const error =
    pending !== null
      ? turnedAway
        ? BUSY_MESSAGE
        : null
      : ranError === BUSY_MESSAGE
        ? null
        : ranError

  const actions: ItemActions = {
    pending,
    error,
    notice,
    onStop: (note) =>
      run("stop", async () => {
        await client.stopWorkItem({ itemId, ...(note ? { note } : {}) })
        return `${label} stopped. A build already running on GitHub finishes on its own.`
      }),
    onReopen: (note) =>
      run("reopen", async () => {
        const reply = await client.reopenWorkItem({ itemId, ...(note ? { note } : {}) })
        return reply.state === "triage"
          ? `${label} reopened: back in triage. No attempt was started.`
          : `${label} reopened; hq retriages it. No attempt was started.`
      }),
    onRevert: (note) =>
      run("revert", async () => {
        await client.requestRevert({ itemId, ...(note ? { note } : {}) })
        return `Revert requested for ${label}. Nothing was reverted on GitHub.`
      }),
    onRetry: (note) =>
      run("retry", async () => {
        await client.retryWorkItem({ itemId, note })
        return `One more fix attempt allowed for ${label}. None was started.`
      }),
    onRequestAttempt: (kind, instructions) =>
      run("request", async () => {
        await client.requestAttempt({
          itemId,
          kind,
          ...(instructions ? { instructions } : {}),
        })
        return `Attempt requested for ${label}. It starts when the agent claims it.`
      }),
    onAnswer: (questionId, optionId) =>
      run(`answer:${questionId}`, async () => {
        await client.answerQuestion({ questionId, optionId })
        return `Answer sent for ${label}.`
      }),
    onApproveMerge: (headSha) =>
      run("approve", async () => {
        const reply = await client.approveMerge({ itemId, headSha })
        return `Merge approved for ${label} at ${sha7(reply.headSha)}. Nothing was merged: merge it on GitHub.`
      }),
  }

  const link = data.signal ? signalLink(data.signal.url, data.repo, data.signal.urlChecked) : null
  const decidedBy = data.mergeApproval?.decidedBy ?? null
  // hq records the deciding founder's id; the only name this app can put to an id is the signed-in
  // founder's own. Anyone else is "a founder": an id is never shown.
  const approvedBy = decidedBy !== null && session.data?.id === decidedBy ? session.data.name : null

  return (
    <ItemPage
      item={data}
      transcript={NOT_RECORDED}
      actions={actions}
      dispatch={board.isPending ? "loading" : (board.data?.dispatch ?? null)}
      issueUrl={link?.kind === "issue" ? link.href : null}
      approvedBy={approvedBy}
    />
  )
}
