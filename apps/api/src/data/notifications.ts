// A person's in-app notifications in one organization, for agents acting for them
// (`list_notifications`). Read only: listing never sets `read` or `seen_at` and never touches
// `inbox_presence`, because a read or seen row drops its pending email and presence decides whether
// an email waits (docs/notifications.md, "Email"). Personal notices (organization_id null) are never
// returned. Newest first, paginated on (created_at, id).
import type { CallerActsFor, Named, OrganizationId } from "@proof/auth-proofs"
import { type Database, notification } from "@proof/db"
import { and, desc, eq, lt, or } from "drizzle-orm"

export interface NotificationRow {
  id: string
  type: string
  title: string
  body: string | null
  href: string | null
  read: boolean
  createdAt: Date
}

export interface NotificationPage {
  /** Whose notifications: the person the caller acts for. */
  userId: string
  /** The last row of the previous page: `createdAt` as an ISO timestamp, and `id`. */
  after?: { at: string; id: string }
  limit: number
}

export function listNotifications<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  page: NotificationPage,
): Promise<NotificationRow[]> {
  // Keyset on (created_at, id), newest first: the next page is everything strictly older.
  const after = page.after
  const older = after
    ? or(
        lt(notification.createdAt, new Date(after.at)),
        and(eq(notification.createdAt, new Date(after.at)), lt(notification.id, after.id)),
      )
    : undefined
  return db
    .select({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      href: notification.href,
      read: notification.read,
      createdAt: notification.createdAt,
    })
    .from(notification)
    .where(
      and(
        eq(notification.userId, page.userId),
        // Equality also leaves out the personal notices, whose organization_id is null.
        eq(notification.organizationId, org.value),
        older,
      ),
    )
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(page.limit)
}
