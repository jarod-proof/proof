import { useState } from "react"
import type { InboxFetchClient } from "@byo-oss/notifications/react"
import { useInbox, useSeenOnView } from "@byo-oss/notifications/react"

import {
  type NotificationItem,
  type NotificationTab,
  NotificationsMenu,
} from "@proof/ui/dplus/shell/notifications-menu"

import type { WebOrganization } from "../lib/web-auth"

export type NotificationsContainerProps = {
  /** The @byo-oss/notifications client (the auth client's `inbox` actions). */
  client: InboxFetchClient
  /** The organizations the shell loaded; a notification's organization is labelled from these. */
  organizations: WebOrganization[]
  /**
   * An impersonated session can list its notifications but the server refuses to mark them read,
   * so the bell only navigates and hides "Mark all read".
   */
  readOnly?: boolean
  /** Client navigation for app paths (the router's navigate). */
  onNavigate: (href: string) => void
}

/** Poll for the unread count this often. The hook pauses while the tab is hidden. */
const POLL_MS = 30_000

/**
 * The top bar's notifications bell. The list covers everything addressed to the person, across
 * organizations, and each row is labelled with its organization. Choosing a row marks it read (when
 * the session can) and follows its link.
 */
export function NotificationsContainer({
  client,
  organizations,
  readOnly = false,
  onNavigate,
}: NotificationsContainerProps) {
  const [tab, setTab] = useState<NotificationTab>("unread")
  const [open, setOpen] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // The hook's own list is every notification; the Unread tab filters on the server, and the
  // filter is also applied here so a switch never shows the other tab's rows while it reloads.
  const inbox = useInbox(client, { filter: tab, pollInterval: POLL_MS, pageSize: 20 })

  const names = new Map(organizations.map((org) => [org.id, org.name]))
  const rows = tab === "unread" ? inbox.notifications.filter((n) => !n.read) : inbox.notifications
  const items: NotificationItem[] = rows.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    createdAt: n.createdAt,
    read: n.read,
    organizationName: n.organizationId ? (names.get(n.organizationId) ?? null) : null,
  }))

  // An unread row counts as seen once at least half of it has been on screen for a second, which
  // drops an "email if unread" still pending for it (docs/notifications.md). Rows below the scroll
  // don't count. An impersonated session isn't the person; it marks none.
  const seenRef = useSeenOnView(inbox.markSeen)
  const seenAt = new Map(rows.map((n) => [n.id, n.seenAt]))
  const rowRef = (item: NotificationItem) =>
    readOnly || item.read || seenAt.get(item.id) ? undefined : seenRef(item.id)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    // Opening the bell always refreshes the list, as @byo-oss/notifications' own panel does: the poll only
    // tracks the unread count, so the rows can be older than the badge.
    if (next) void inbox.refresh().catch(() => undefined)
  }

  const handleSelect = (item: NotificationItem) => {
    const target = inbox.notifications.find((n) => n.id === item.id)
    if (!target) return
    setOpen(false)
    void (async () => {
      // Mark first, so the count the destination shows is already right. A refused or failed
      // mark does not block the navigation.
      if (!readOnly && !target.read) await inbox.markRead(target.id).catch(() => undefined)
      if (target.href) onNavigate(target.href)
    })()
  }

  const handleLoadMore = () => {
    setLoadingMore(true)
    void inbox
      .loadMore()
      .catch(() => undefined)
      .finally(() => setLoadingMore(false))
  }

  return (
    <NotificationsMenu
      items={items}
      unreadCount={inbox.unreadCount}
      tab={tab}
      onTabChange={setTab}
      open={open}
      onOpenChange={handleOpenChange}
      onSelect={handleSelect}
      canMarkAllRead={!readOnly}
      onMarkAllRead={() => void inbox.markAllRead().catch(() => undefined)}
      hasMore={inbox.hasMore}
      loadingMore={loadingMore}
      onLoadMore={handleLoadMore}
      loading={inbox.isLoading}
      failed={Boolean(inbox.error)}
      rowRef={rowRef}
    />
  )
}
