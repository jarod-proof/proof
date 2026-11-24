import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { HqError } from "../api/errors"
import { hqKeys } from "../api/query-keys"
import type { Proposal } from "../api/schemas"
import { ProposalCard } from "../components/proposal-card"
import { errorMessage } from "../components/states"
import { useHq } from "../lib/use-hq"
import { ApprovalsPage, type Load, type Notice } from "../pages/approvals-page"

const PENDING_PAGE_SIZE = 25
/**
 * Each decided status is asked for this many, then merged by decision time. "Recently decided" is
 * therefore approximate: hq orders `list_proposals` by creation only (a Phase 4+ item is a
 * decided-time order), so a proposal created long ago and decided just now can be missing. Nothing
 * a founder must read depends on a row here (see `Notice`).
 */
const DECIDED_FETCH_LIMIT = 50
const DECIDED_SHOWN = 20
const ALREADY_DECIDED = "Already decided. Refresh to see the result."
const PROPOSALS_PREFIX = hqKeys.proposals()[0]

/**
 * What a failed decision says. A 409 on a proposal that was decided already reads as such; any
 * other 409 (the entry moved on) and a 403 keep hq's own words, since hq is the one deciding.
 */
export function decisionMessage(error: unknown): string {
  if (error instanceof HqError) {
    if (error.kind === "conflict") {
      return error.message.startsWith("The proposal was already") ? ALREADY_DECIDED : error.message
    }
    if (error.kind === "forbidden") return error.message
  }
  return errorMessage(error)
}

/**
 * One pending proposal and its decision. Each card owns its mutation, so two cards decide
 * independently; a decision is sent from a click only, once, and never retried.
 */
function DecidableCard({
  proposal,
  onNotice,
}: {
  proposal: Proposal
  onNotice(proposalId: string, notice: Notice | null): void
}) {
  const { client, queryClient } = useHq()
  // A second click can land before React has disabled the button; this closes that gap.
  const sent = useRef(false)

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [PROPOSALS_PREFIX] }),
      queryClient.invalidateQueries({ queryKey: hqKeys.factoryStatus() }),
    ])

  const mutation = useMutation({
    retry: false,
    mutationFn: (input: { decision: "approve" | "reject"; note?: string }) =>
      client.decideProposal({ proposalId: proposal.id, ...input }),
    onSuccess: async (_decision, input) => {
      // Kept until dismissed, for a card that leaves Needs you with no decided row to show it.
      onNotice(proposal.id, {
        title: proposal.title,
        message: input.decision === "approve" ? "Approved." : "Rejected.",
        tone: "done",
      })
      await refresh()
    },
    onError: async (error) => {
      sent.current = false
      onNotice(proposal.id, {
        title: proposal.title,
        message: decisionMessage(error),
        tone: "error",
      })
      if (error instanceof HqError && error.kind === "conflict") await refresh()
      // The session ended: the gate's probe sends the app to sign-in.
      if (error instanceof HqError && error.kind === "unauthorized") {
        await queryClient.invalidateQueries({ queryKey: hqKeys.status() })
      }
    },
  })

  return (
    <ProposalCard
      proposal={proposal}
      pending={mutation.isPending || mutation.isSuccess}
      error={mutation.error ? decisionMessage(mutation.error) : null}
      onDecide={(input) => {
        if (sent.current || mutation.isPending || mutation.isSuccess) return
        sent.current = true
        onNotice(proposal.id, null)
        mutation.mutate(input)
      }}
    />
  )
}

function toLoad<T>(
  query: { isPending: boolean; isError: boolean; error: unknown; refetch(): unknown },
  items: () => T,
): Load<T> {
  if (query.isError) {
    const error =
      query.error instanceof HqError
        ? query.error
        : new HqError({ kind: "server", status: 0, message: "unexpected" })
    return { status: "error", error, onRetry: () => void query.refetch() }
  }
  return query.isPending ? { status: "loading" } : { status: "ready", items: items() }
}

/** The Approvals screen: the pending proposals, and the last decided ones. */
export function Approvals() {
  const { client } = useHq()
  const [notices, setNotices] = useState<Record<string, Notice>>({})
  const dropNotice = (id: string) =>
    setNotices((current) => {
      const { [id]: _dropped, ...rest } = current
      return rest
    })

  const pending = useInfiniteQuery({
    queryKey: hqKeys.proposals("pending"),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.listProposals({
        status: "pending",
        limit: PENDING_PAGE_SIZE,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const approved = useQuery({
    queryKey: hqKeys.proposals("approved"),
    queryFn: () => client.listProposals({ status: "approved", limit: DECIDED_FETCH_LIMIT }),
  })
  const rejected = useQuery({
    queryKey: hqKeys.proposals("rejected"),
    queryFn: () => client.listProposals({ status: "rejected", limit: DECIDED_FETCH_LIMIT }),
  })

  const decidedQuery = {
    isPending: approved.isPending || rejected.isPending,
    isError: approved.isError || rejected.isError,
    error: approved.error ?? rejected.error,
    refetch: () => {
      if (approved.isError) void approved.refetch()
      if (rejected.isError) void rejected.refetch()
    },
  }

  return (
    <ApprovalsPage
      pending={toLoad(pending, () => pending.data?.pages.flatMap((page) => page.proposals) ?? [])}
      decided={toLoad(decidedQuery, () =>
        [...(approved.data?.proposals ?? []), ...(rejected.data?.proposals ?? [])]
          .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
          .slice(0, DECIDED_SHOWN),
      )}
      renderPending={(proposal) => (
        <DecidableCard
          proposal={proposal}
          onNotice={(id, notice) =>
            notice === null
              ? dropNotice(id)
              : setNotices((current) => ({ ...current, [id]: notice }))
          }
        />
      )}
      notices={notices}
      onDismissNotice={dropNotice}
      hasMore={pending.hasNextPage}
      loadingMore={pending.isFetchingNextPage}
      onLoadMore={() => void pending.fetchNextPage()}
    />
  )
}
