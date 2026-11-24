import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { HqError } from "../api/errors"
import { hqKeys } from "../api/query-keys"
import type { NeedsYou } from "../api/schemas"
import { needKey, type NeedsYouActions } from "../components/needs-you-card"
import { ErrorBlock, LoadingBlock } from "../components/states"
import { useHq } from "../lib/use-hq"
import { useOneWrite } from "../lib/use-one-write"
import { WorkPage } from "../pages/work-page"

/** The search asks for this many matches (hq's maximum); more are said to exist. */
const SEARCH_LIMIT = 100
const CREATE_KEY = "create"

/**
 * The Work board screen. It reads hq's board and renders it as it is. Every write is sent from a
 * click only, once (a synchronous lock closes the gap before React disables the buttons), never
 * retried, and one at a time: while a write is on its way nothing else on the board can be
 * clicked, and the card stays disabled until the board has been read again.
 */
export function Work() {
  const { client, queryClient } = useHq()
  const [query, setQuery] = useState("")
  const [created, setCreated] = useState<string | null>(null)
  const { pending, errors, notice, write } = useOneWrite({ queryClient })

  const board = useQuery({
    queryKey: hqKeys.workBoard(),
    queryFn: () => client.getWorkBoard(),
  })
  const term = query.trim()
  const search = useQuery({
    queryKey: hqKeys.workItems(term),
    queryFn: () => client.listWorkItems({ query: term, limit: SEARCH_LIMIT }),
    enabled: term !== "",
  })

  const needs: NeedsYou[] = board.data?.needsYou ?? []
  const actions: NeedsYouActions = {
    pending,
    errors,
    onApproveMerge: (need) => {
      const merge = need.merge
      if (!merge) return
      void write(needKey(need), async () => {
        const reply = await client.approveMerge({ itemId: need.itemId, headSha: merge.headSha })
        return `Merge approved for ${need.displayId} at ${reply.headSha.slice(0, 7)}. Nothing was merged: merge it on GitHub.`
      })
    },
    onAnswer: (questionId, optionId) => {
      const need = needs.find((n) => n.question?.questionId === questionId)
      if (!need) return
      void write(needKey(need), async () => {
        await client.answerQuestion({ questionId, optionId })
        return `Answer sent for ${need.displayId}.`
      })
    },
    onRetry: (itemId, note) => {
      const need = needs.find((n) => n.itemId === itemId && n.kind === "attempt_budget")
      if (!need) return
      void write(needKey(need), async () => {
        await client.retryWorkItem({ itemId, note })
        return `One more fix attempt allowed for ${need.displayId}. None was started.`
      })
    },
  }

  if (board.data === undefined) {
    return board.isError ? (
      <ErrorBlock
        error={
          board.error instanceof HqError
            ? board.error
            : new HqError({ kind: "server", status: 0, message: "unexpected" })
        }
        onRetry={() => void board.refetch()}
      />
    ) : (
      <LoadingBlock label="the work board" />
    )
  }

  return (
    <WorkPage
      board={board.data}
      query={query}
      onQuery={setQuery}
      results={term === "" ? null : (search.data?.items ?? null)}
      {...(term !== "" && search.data === undefined
        ? {
            searchLoad: search.isError
              ? {
                  status: "error" as const,
                  error:
                    search.error instanceof HqError
                      ? search.error
                      : new HqError({ kind: "server", status: 0, message: "unexpected" }),
                  onRetry: () => void search.refetch(),
                }
              : { status: "loading" as const },
          }
        : {})}
      resultsTruncated={search.data?.nextCursor != null}
      creating={pending === CREATE_KEY}
      createError={errors[CREATE_KEY] ?? null}
      created={created}
      notice={notice}
      onCreate={(input) =>
        void write(CREATE_KEY, async () => {
          const reply = await client.createWorkItem(input)
          setCreated(reply.displayId)
          return `Created ${reply.displayId}. It is in Triage.`
        })
      }
      actions={actions}
    />
  )
}
