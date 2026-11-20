// Tenant data access. Every function takes the organization as a Named id plus a proof that the
// caller acts for it, so a query can't be written against another organization's rows.
import type {
  CallerActsFor,
  Named,
  OrganizationId,
  ProjectId,
  ProjectInOrg,
} from "@proof/auth-proofs"
import { AppError } from "@proof/errors"
import { type Database, project } from "@proof/db"
import { and, asc, eq, gt, or, sql } from "drizzle-orm"

export type Project = typeof project.$inferSelect

/**
 * Projects are ordered by creation time to the millisecond, then id. The database keeps microseconds
 * and a JS Date only has milliseconds, so the order and the cursor both use the truncated value.
 */
const createdMs = sql<Date>`date_trunc('milliseconds', ${project.createdAt})`

export interface ProjectPage {
  /** The last project of the previous page: its creation time (ISO, to the millisecond) and id. */
  after?: { at: string; id: string }
  limit: number
}

export function listProjects<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  page: ProjectPage,
): Promise<Project[]> {
  // The cursor time goes in as an ISO string cast to timestamp, the same way the column stores it
  // (timestamp without time zone, UTC wall clock), not as a bound Date.
  const after = page.after
  const at = after ? sql`${after.at}::timestamp` : undefined
  const later =
    after && at
      ? or(sql`${createdMs} > ${at}`, and(sql`${createdMs} = ${at}`, gt(project.id, after.id)))
      : undefined
  return db
    .select()
    .from(project)
    .where(and(eq(project.organizationId, org.value), later))
    .orderBy(asc(createdMs), asc(project.id))
    .limit(page.limit)
}

export async function createProject<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  input: { name: string },
  _proof: CallerActsFor<O>,
): Promise<Project> {
  const [row] = await db
    .insert(project)
    // Stamped here, not by the column default: created_at has no time zone, so now() would store
    // the database session's local time when that isn't UTC.
    .values({
      id: crypto.randomUUID(),
      organizationId: org.value,
      name: input.name,
      createdAt: new Date(),
    })
    .returning()
  if (!row) throw new AppError("INTERNAL", "insert returned no row")
  return row
}

export async function deleteProject<P, O>(
  db: Database,
  id: Named<P, ProjectId>,
  org: Named<O, OrganizationId>,
  _proofs: { inOrg: ProjectInOrg<P, O>; actor: CallerActsFor<O> },
): Promise<void> {
  // The org filter repeats the proof's check, so a stale proof can't delete across tenants.
  await db
    .delete(project)
    .where(and(eq(project.id, id.value), eq(project.organizationId, org.value)))
}
