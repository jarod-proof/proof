import { QueryCache, QueryClient } from "@tanstack/react-query"

import { HqError } from "./errors"
import { hqKeys } from "./query-keys"

const MAX_QUERY_RETRIES = 2

/** Only a flaky network or a failing server is worth asking again; a refusal never changes. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return (
    error instanceof HqError &&
    (error.kind === "unreachable" || error.kind === "server") &&
    failureCount < MAX_QUERY_RETRIES
  )
}

/**
 * Queries retry unreachable and server errors twice; mutations never retry (a decision is sent
 * once). An `unauthorized` reply invalidates the gate's status probe so the app lands on sign-in.
 */
export function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // Not for the status probe itself: its 401 would invalidate (refetch) itself, forever.
        const isStatusProbe = query.queryKey[0] === hqKeys.status()[0]
        if (error instanceof HqError && error.kind === "unauthorized" && !isStatusProbe) {
          void queryClient.invalidateQueries({ queryKey: hqKeys.status() })
        }
      },
    }),
    defaultOptions: {
      queries: { retry: shouldRetryQuery, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
  return queryClient
}
