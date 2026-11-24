import { useQuery } from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"

import { HqError } from "../api/errors"
import { hqKeys } from "../api/query-keys"
import { useSessionEmail, useSignOut } from "../containers/account"
import { useHq } from "../lib/use-hq"
import { GateShell, NotFounderPanel, RefusedPanel } from "./gate-panels"
import { ErrorBlock, LoadingBlock } from "./states"

function NotFounder() {
  const email = useSessionEmail()
  const { signOut, pending, error } = useSignOut()
  return <NotFounderPanel email={email} onSignOut={signOut} pending={pending} error={error} />
}

/** Sends a signed-out visitor to sign-in once, remembering where they were going. */
function ToSignIn({ next }: { next: string }) {
  const navigate = useNavigate()
  // `next` is where the visitor was when the 401 came. The router updates its location before this
  // component unmounts, so a live `next` would read /sign-in and send the visitor there again, nested.
  const [wanted] = useState(next)
  useEffect(() => {
    void navigate({ to: "/sign-in", search: { next: wanted }, replace: true })
  }, [navigate, wanted])
  return <LoadingBlock label="sign-in" />
}

/**
 * The gate every screen sits behind. It asks hq for GET /v1/status and renders by the answer:
 * signed out goes to sign-in (and back), a non-founder gets the explanation, a refused hq says so,
 * an unreachable or failing hq gets Retry, and only a founder gets the screens.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const { client } = useHq()
  const location = useRouterState({ select: (state) => state.location })
  const status = useQuery({ queryKey: hqKeys.status(), queryFn: () => client.status() })

  if (status.isError) {
    const error =
      status.error instanceof HqError
        ? status.error
        : new HqError({ kind: "server", status: 0, message: "unexpected" })
    const retry = () => void status.refetch()
    switch (error.kind) {
      case "unauthorized":
        return (
          <GateShell>
            <ToSignIn next={`${location.pathname}${location.searchStr}`} />
          </GateShell>
        )
      case "forbidden":
        return <NotFounder />
      case "refused":
        return <RefusedPanel error={error} onRetry={retry} retrying={status.isFetching} />
      default:
        return (
          <GateShell>
            <ErrorBlock error={error} onRetry={retry} />
          </GateShell>
        )
    }
  }
  if (status.isPending) {
    return (
      <GateShell>
        <LoadingBlock label="hq" />
      </GateShell>
    )
  }
  return <>{children}</>
}
