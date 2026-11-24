import { useQuery } from "@tanstack/react-query"

import { HqError } from "../api/errors"
import { hqKeys } from "../api/query-keys"
import { ErrorBlock, LoadingBlock } from "../components/states"
import { useHq } from "../lib/use-hq"
import { RunnerHeader, RunnerPage } from "../pages/runner-page"

function asHqError(error: unknown): HqError {
  return error instanceof HqError
    ? error
    : new HqError({ kind: "server", status: 0, message: "unexpected" })
}

/**
 * The Runner and policy screen. It reads two things and writes nothing: `get_factory_status`
 * (under the sidebar's own key, so the page and the runner card share one request and one poll)
 * and `get_policy`.
 */
export function Runner() {
  const { client } = useHq()
  const status = useQuery({
    queryKey: hqKeys.factoryStatus(),
    queryFn: () => client.getFactoryStatus(),
  })
  const policy = useQuery({ queryKey: hqKeys.policy(), queryFn: () => client.getPolicy() })

  // A refetch that failed keeps the data on screen; only a first failure is an error.
  if (status.data && policy.data) return <RunnerPage status={status.data} policy={policy.data} />

  const failed = status.isError ? status : policy.isError ? policy : null
  return (
    <>
      <RunnerHeader />
      {failed ? (
        <ErrorBlock error={asHqError(failed.error)} onRetry={() => void failed.refetch()} />
      ) : (
        <LoadingBlock label="runner and policy" />
      )}
    </>
  )
}
