// Audit trail: who (a user or an API key, possibly through an OAuth client) ran which operation in
// an organization, and how it ended. Newest first, paginated on (at, id).
import { personalSlug } from "@proof/auth"
import {
  type CallerActsFor,
  memberInOrg,
  name,
  type Named,
  OrganizationId,
  UserId,
} from "@proof/auth-proofs"
import { auditEvent, type Database, organization } from "@proof/db"
import type { ErrorCode } from "@proof/errors"
import { createLogger } from "@proof/logger"
import { and, desc, eq, lt, or } from "drizzle-orm"

const logger = createLogger({ name: "audit" })

export interface AuditEventInput {
  actorType: "user" | "apiKey"
  actorId: string
  clientId?: string
  operation: string
  outcome: "ok" | ErrorCode
  requestId?: string
}

export interface AuditEventRow {
  id: string
  at: Date
  actorType: string
  actorId: string
  clientId: string | null
  operation: string
  outcome: string
  requestId: string | null
}

export interface AuditPage {
  /** The last row of the previous page: `at` as an ISO timestamp, and `id`. */
  after?: { at: string; id: string }
  limit: number
}

export async function recordAuditEvent<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  e: AuditEventInput,
): Promise<void> {
  await db.insert(auditEvent).values({
    id: crypto.randomUUID(),
    organizationId: org.value,
    at: new Date(),
    actorType: e.actorType,
    actorId: e.actorId,
    clientId: e.clientId ?? null,
    operation: e.operation,
    outcome: e.outcome,
    requestId: e.requestId ?? null,
  })
}

export function listAuditEvents<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  page: AuditPage,
): Promise<AuditEventRow[]> {
  // Keyset on (at, id), newest first: the next page is everything strictly older than the cursor.
  const after = page.after
  const older = after
    ? or(
        lt(auditEvent.at, new Date(after.at)),
        and(eq(auditEvent.at, new Date(after.at)), lt(auditEvent.id, after.id)),
      )
    : undefined
  return db
    .select({
      id: auditEvent.id,
      at: auditEvent.at,
      actorType: auditEvent.actorType,
      actorId: auditEvent.actorId,
      clientId: auditEvent.clientId,
      operation: auditEvent.operation,
      outcome: auditEvent.outcome,
      requestId: auditEvent.requestId,
    })
    .from(auditEvent)
    .where(and(eq(auditEvent.organizationId, org.value), older))
    .orderBy(desc(auditEvent.at), desc(auditEvent.id))
    .limit(page.limit)
}

/**
 * An auth event as packages/auth emits it (`AuthEvent` there; the shape is structural, since the
 * package doesn't export its types through the data layer's import path).
 */
export interface AuthEventRecord {
  name: string
  userId: string | null
  organizationId: string | null
  outcome: string
  ip?: string
  path: string
}

/**
 * Stores an auth event as an audit row with the person as the actor. The row goes to the event's
 * organization when the person is a member of it, else to their personal organization. Returns
 * whether a row was written.
 *
 * There is no caller here: auth hooks run in the server, not for a request acting in an org. So the
 * proof is the membership itself, minted by `memberInOrg` (a lookup, the same one that backs the
 * caller's principal) rather than a caller's `CallerActsFor`. A person who isn't a member of the
 * named organization gets the personal one, so no event can be written into an org they don't
 * belong to. An unknown email (`userId` null) writes nothing: it is logged without the email.
 */
export async function recordAuthEvent(db: Database, event: AuthEventRecord): Promise<boolean> {
  const userId = event.userId
  if (!userId) {
    logger.info({ event: event.name, ip: event.ip }, "auth event without an account; not stored")
    return false
  }
  const [personal] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, personalSlug(userId)))
    .limit(1)
  const candidates = [event.organizationId, personal?.id].filter(
    (id): id is string => typeof id === "string",
  )
  return name(UserId(userId), async (user) => {
    for (const orgId of candidates) {
      const written = await name(OrganizationId(orgId), async (org) => {
        const proof = await memberInOrg(db, user, org)
        if (!proof) return false
        await db.insert(auditEvent).values({
          id: crypto.randomUUID(),
          organizationId: org.value,
          at: new Date(),
          actorType: "user",
          actorId: userId,
          clientId: null,
          operation: event.name,
          outcome: event.outcome,
          requestId: null,
        })
        return true
      })
      if (written) return true
    }
    return false
  })
}
