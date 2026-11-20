import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Button } from "@proof/ui/components/ui/button"

import type { AdminApi } from "../lib/admin-api"
import { adminSessionQuery } from "./admin-data"

/**
 * A persistent strip across the app while an admin is acting as someone else (the session carries
 * `impersonatedBy`). Renders nothing otherwise, including while signed out. Stop returns the admin to
 * /admin/users, with a fresh cache so nothing from the impersonated session stays visible.
 */
export function ImpersonationBanner({
  api,
  onNavigate,
}: {
  api: AdminApi
  onNavigate: (href: string) => void
}) {
  const queryClient = useQueryClient()
  const session = useQuery(adminSessionQuery(api))
  const stop = useMutation({
    mutationFn: () => api.stopImpersonating(),
    onSuccess: () => {
      // reset, not clear: a page that stays mounted through the navigation (the router keeps the
      // old page while the next one loads) must refetch as the admin, not keep the old answers
      void queryClient.resetQueries()
      onNavigate("/admin/users")
    },
  })

  const current = session.data
  if (!current?.impersonatedBy) return null

  return (
    <output
      aria-label="Impersonation"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 border-b-2 border-foreground bg-solar px-4 py-2 text-sm font-bold text-solar-foreground"
    >
      <span>You are impersonating {current.name || current.email} · you act as them</span>
      <Button
        variant="outline"
        className="bg-background text-foreground"
        disabled={stop.isPending}
        onClick={() => stop.mutate()}
      >
        Stop
      </Button>
      {stop.isError ? (
        <p role="alert" className="w-full text-destructive">
          Could not stop impersonating. Try again.
        </p>
      ) : null}
    </output>
  )
}
