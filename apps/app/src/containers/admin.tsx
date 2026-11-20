import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useDebouncedValue } from "@tanstack/react-pacer"
import { useState } from "react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"
import type { SettingsTab } from "@proof/ui/dplus/shell/settings-header"

import { useReauthGuard } from "../components/reauth-dialog"
import type { AdminApi } from "../lib/admin-api"
import { adminKeys } from "../lib/admin-keys"
import { messageOf } from "../lib/messages"
import { WebError } from "../lib/web-auth"
import { AdminNotAvailable, AdminPage, ADMIN_PAGE_SIZE } from "../pages/admin-page"
import { type AdminAction, adminSessionQuery, isPlatformAdmin, runAdminAction } from "./admin-data"

export interface AdminContainerProps {
  api: AdminApi
  /** The admin console's tabs this person may open. */
  tabs: SettingsTab[]
  /** Client navigation (the router's navigate), used after impersonating and for the app links. */
  onNavigate: (href: string) => void
  renderLink: RenderLink
}

/**
 * The admin console's Users tab (/admin/users): the session (who may open it), the paged and searched user list, and the
 * actions. The server decides every call; this only shows what it answers.
 */
export function AdminContainer({ api, tabs, onNavigate, renderLink }: AdminContainerProps) {
  const queryClient = useQueryClient()
  // Impersonating and changing a role need a recent sign-in; the other actions are guarded alike.
  const guard = useReauthGuard()
  const session = useQuery(adminSessionQuery(api))
  const [search, setSearch] = useState("")
  const [offset, setOffset] = useState(0)
  const [debouncedSearch] = useDebouncedValue(search, { wait: 300 })
  const query = { search: debouncedSearch.trim(), offset, limit: ADMIN_PAGE_SIZE }
  const admin = isPlatformAdmin(session.data)

  const users = useQuery({
    queryKey: adminKeys.list(query),
    queryFn: () => api.listUsers(query),
    placeholderData: keepPreviousData,
    enabled: admin,
  })

  const act = useMutation({
    mutationFn: (action: AdminAction) => guard(() => runAdminAction(api, action)),
    onSuccess: (_result, action) => {
      // Impersonating changes who the session is: nothing cached can be kept. Stopping does the same
      // in the banner. Everything else only changes the list.
      if (action.kind === "impersonate") {
        // reset, not clear: this page can stay mounted while "/" loads, and must not keep the
        // admin's answers for the impersonated session
        void queryClient.resetQueries()
        onNavigate("/")
        return
      }
      void queryClient.invalidateQueries({ queryKey: adminKeys.users() })
    },
  })

  if (session.isPending) {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }
  if (!session.data || !admin) return <AdminNotAvailable renderLink={renderLink} />

  // A 403 from the list means the role changed after the page loaded: the same answer as the guard.
  if (users.error instanceof WebError && users.error.status === 403) {
    return <AdminNotAvailable renderLink={renderLink} />
  }

  return (
    <AdminPage
      me={session.data}
      tabs={tabs}
      users={users.data?.users ?? []}
      total={users.data?.total ?? 0}
      loading={users.isPending}
      error={users.error ? messageOf(users.error) : null}
      search={search}
      onSearch={(value) => {
        setSearch(value)
        setOffset(0)
      }}
      offset={offset}
      limit={ADMIN_PAGE_SIZE}
      onPage={setOffset}
      onAction={(action) => act.mutateAsync(action)}
      renderLink={renderLink}
    />
  )
}
