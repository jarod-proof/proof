import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { type SupportFetchClient, SupportInbox } from "@byo-oss/support/react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"

import { adminTabs } from "../lib/admin-nav"
import {
  SUPPORT_QUEUE_LABELS,
  SUPPORT_QUEUE_PATH,
  type SupportApi,
  getSupportApi,
} from "../lib/support-api"
import type { WebAuth } from "../lib/web-auth"
import { AdminNotAvailable } from "../pages/admin-page"
import { SupportAdminError, SupportAdminPage } from "../pages/support-pages"
import { type AdminAccessApis, useAdminAccess } from "./admin-access"
import { supportQueueAccessQuery, supportStaffListQuery } from "./support-data"

export interface AdminSupportContainerProps {
  auth: WebAuth
  /** Who may open which console tab. Defaults to the browser's APIs. */
  apis?: AdminAccessApis
  /** The staff list for the queue's pickers. Defaults to the browser's. */
  support?: SupportApi
  /** The open ticket, from the URL (/admin/support/$id); opening another one navigates there. */
  ticketId?: string
  onNavigate: (href: string) => void
  renderLink?: RenderLink
  /** Poll interval in ms; tests pass 0. */
  pollInterval?: number
}

const FOR_WHOM = "support staff: members of the operator organization whose role answers tickets"

/**
 * The admin console's Support tab: the support queue (@byo-oss/support's SupportInbox). Support's
 * staff check works whatever organization the session has active, so the session stays where it is
 * (no OrgGate). Support itself is asked first whether this session is staff.
 */
export function AdminSupportContainer({
  auth,
  apis,
  support,
  ticketId,
  onNavigate,
  renderLink,
  pollInterval,
}: AdminSupportContainerProps) {
  const client = auth.support
  if (!client) return <AdminNotAvailable forWhom={FOR_WHOM} renderLink={renderLink} />
  return (
    <SupportQueue
      client={client}
      apis={apis}
      support={support ?? getSupportApi()}
      ticketId={ticketId}
      onNavigate={onNavigate}
      renderLink={renderLink}
      pollInterval={pollInterval}
    />
  )
}

function SupportQueue({
  client,
  apis,
  support,
  ticketId,
  onNavigate,
  renderLink,
  pollInterval,
}: Omit<AdminSupportContainerProps, "auth" | "support"> & {
  client: SupportFetchClient
  support: SupportApi
}) {
  const { access, pending } = useAdminAccess(apis)
  const queueAccess = useQuery(supportQueueAccessQuery(support))
  const operatorOrganizationId = access.operatorOrganizationId
  const staff = useQuery({
    ...supportStaffListQuery(support, operatorOrganizationId ?? ""),
    enabled: queueAccess.data === "staff" && operatorOrganizationId !== null,
  })
  const signedOut = queueAccess.data === "signed-out"
  const here = ticketId
    ? `${SUPPORT_QUEUE_PATH}/${encodeURIComponent(ticketId)}`
    : SUPPORT_QUEUE_PATH

  // Signed out mid-visit (the session expired): back to sign-in, which returns here.
  useEffect(() => {
    if (signedOut) onNavigate(`/sign-in?next=${encodeURIComponent(here)}`)
  }, [signedOut, onNavigate, here])

  if (pending || queueAccess.isPending || signedOut) {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }
  if (queueAccess.isError) return <SupportAdminError onRetry={() => void queueAccess.refetch()} />
  if (queueAccess.data === "not-staff") {
    return <AdminNotAvailable forWhom={FOR_WHOM} renderLink={renderLink} />
  }
  if (staff.isPending && staff.fetchStatus !== "idle") {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }
  return (
    <SupportAdminPage
      // Support said yes, so the tab shows even if the role lookup hasn't caught up.
      tabs={adminTabs({ ...access, supportStaff: true })}
      renderLink={renderLink}
      notice={
        staff.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load the support staff, so tickets can't be assigned or anyone mentioned.
          </p>
        ) : null
      }
    >
      <SupportInbox
        client={client}
        agents={staff.data ?? []}
        ticketId={ticketId ?? null}
        // The URL follows the open ticket, so a reload or a shared link opens it again.
        onTicketChange={(next) =>
          onNavigate(
            next ? `${SUPPORT_QUEUE_PATH}/${encodeURIComponent(next)}` : SUPPORT_QUEUE_PATH,
          )
        }
        onNavigate={onNavigate}
        labels={SUPPORT_QUEUE_LABELS}
        className="min-h-0 flex-1"
        {...(pollInterval === undefined ? {} : { pollInterval })}
      />
    </SupportAdminPage>
  )
}
