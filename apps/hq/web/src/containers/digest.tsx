import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { hqKeys } from "../api/query-keys"
import { ErrorBlock, LoadingBlock } from "../components/states"
import { HqError } from "../api/errors"
import { useReadMarker } from "../lib/read-marker"
import { useHq } from "../lib/use-hq"
import { DigestPage } from "../pages/digest-page"

/** The Digest screen: get_digest from the read marker on, and the cap from get_factory_status. */
export function Digest() {
  const { client } = useHq()
  const { readAt, markRead, clear } = useReadMarker()
  // Only for this visit: coming back later, the marker still bounds the window but the button is live.
  const [marked, setMarked] = useState(false)
  const since = readAt ?? undefined
  const digest = useQuery({
    queryKey: hqKeys.digest(since),
    queryFn: () => client.getDigest(since === undefined ? {} : { since }),
    placeholderData: keepPreviousData,
  })
  const status = useQuery({
    queryKey: hqKeys.factoryStatus(),
    queryFn: () => client.getFactoryStatus(),
  })

  // hq refused the stored time (a since after its now, or a hand-edited value): forget it and ask
  // for the default window, so the screen can never stay stuck on a marker nothing can clear.
  const refusedMarker =
    since !== undefined && digest.error instanceof HqError && digest.error.kind === "bad-request"
  useEffect(() => {
    if (refusedMarker) clear()
  }, [refusedMarker, clear])

  if (digest.data === undefined) {
    return digest.isError ? (
      <ErrorBlock
        error={
          digest.error instanceof HqError
            ? digest.error
            : new HqError({ kind: "server", status: 0, message: "unexpected" })
        }
        onRetry={() => void digest.refetch()}
      />
    ) : (
      <LoadingBlock label="the digest" />
    )
  }
  return (
    <DigestPage
      digest={digest.data}
      allowance={status.data?.allowance ?? null}
      readMarked={marked}
      onMarkRead={() => {
        if (marked) return
        setMarked(true)
        markRead(digest.data.until)
      }}
    />
  )
}
