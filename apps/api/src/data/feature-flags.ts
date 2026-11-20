// Feature flag rollouts. Managing them takes the OperatorOrg proof: only the operator organization
// changes who sees a flag, and every query still filters by its id. Evaluating them is the one
// system-level read (loadRollouts): every organization's requests need every flag's state, and it
// returns no organization's data, only each flag's switch and percentage. Targets are read per
// organization, with the caller's own proof.
import type {
  CallerActsFor,
  FeatureFlagKey,
  FlagInOrg,
  Named,
  OperatorOrg,
  OrganizationId,
} from "@proof/auth-proofs"
import {
  type Database,
  featureFlag,
  featureFlagExposureDaily,
  featureFlagTarget,
  organization,
} from "@proof/db"
import { AppError } from "@proof/errors"
import type { Rollout } from "@proof/flags"
import { and, asc, count, eq, gte, inArray, isNull, or, sql } from "drizzle-orm"

export type FlagRow = typeof featureFlag.$inferSelect

/** Every flag's rollout, by key, for evaluation. Small (one row per flag) and cached by the caller. */
export async function loadRollouts(db: Database): Promise<Map<string, Rollout>> {
  const rows = await db
    .select({
      key: featureFlag.key,
      enabled: featureFlag.enabled,
      percentage: featureFlag.percentage,
      reclaimedValue: featureFlag.reclaimedValue,
    })
    .from(featureFlag)
  return new Map(rows.map(({ key, ...rollout }) => [key, rollout]))
}

/** The organization's own target values, by flag key. */
export async function targetsOf<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
): Promise<Map<string, boolean>> {
  const rows = await db
    .select({ key: featureFlagTarget.flagKey, value: featureFlagTarget.value })
    .from(featureFlagTarget)
    .where(eq(featureFlagTarget.organizationId, org.value))
  return new Map(rows.map((r) => [r.key, r.value]))
}

export interface ManagedRollout extends FlagRow {
  /** Organizations turned on, and turned off, by a target. */
  targetsOn: number
  targetsOff: number
}

/** The operator's rollouts, oldest first, with their target counts. */
export async function listRollouts<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: OperatorOrg<O>,
): Promise<ManagedRollout[]> {
  const rows = await db
    .select()
    .from(featureFlag)
    .where(eq(featureFlag.organizationId, org.value))
    .orderBy(asc(featureFlag.createdAt), asc(featureFlag.key))
  const counts = await db
    .select({ key: featureFlagTarget.flagKey, value: featureFlagTarget.value, n: count() })
    .from(featureFlagTarget)
    .innerJoin(featureFlag, eq(featureFlag.key, featureFlagTarget.flagKey))
    .where(eq(featureFlag.organizationId, org.value))
    .groupBy(featureFlagTarget.flagKey, featureFlagTarget.value)
  const n = (key: string, value: boolean) =>
    counts.find((c) => c.key === key && c.value === value)?.n ?? 0
  return rows.map((row) => ({ ...row, targetsOn: n(row.key, true), targetsOff: n(row.key, false) }))
}

/** One rollout of the operator's, or null when the flag has none yet. */
export async function getRollout<O>(
  db: Database,
  key: string,
  org: Named<O, OrganizationId>,
  proof: OperatorOrg<O>,
): Promise<ManagedRollout | null> {
  const rows = await listRollouts(db, org, proof)
  return rows.find((r) => r.key === key) ?? null
}

export interface TargetRow {
  organizationId: string
  name: string
  slug: string
  value: boolean
  createdAt: Date
}

/** A rollout's targets, with each organization's name and slug, oldest first. */
export function listTargets<K, O>(
  db: Database,
  key: Named<K, FeatureFlagKey>,
  org: Named<O, OrganizationId>,
  _proofs: { inOrg: FlagInOrg<K, O>; operator: OperatorOrg<O> },
): Promise<TargetRow[]> {
  return db
    .select({
      organizationId: featureFlagTarget.organizationId,
      name: organization.name,
      slug: organization.slug,
      value: featureFlagTarget.value,
      createdAt: featureFlagTarget.createdAt,
    })
    .from(featureFlagTarget)
    .innerJoin(organization, eq(organization.id, featureFlagTarget.organizationId))
    .innerJoin(featureFlag, eq(featureFlag.key, featureFlagTarget.flagKey))
    .where(and(eq(featureFlagTarget.flagKey, key.value), eq(featureFlag.organizationId, org.value)))
    .orderBy(asc(featureFlagTarget.createdAt), asc(featureFlagTarget.organizationId))
}

/**
 * Create the flag's rollout if it has none (off, 0%), then apply `patch`. A rollout managed by
 * another organization (a former operator) is not touched: null comes back.
 */
export async function saveRollout<O>(
  db: Database,
  key: string,
  org: Named<O, OrganizationId>,
  _proof: OperatorOrg<O>,
  patch: { enabled?: boolean; percentage?: number },
  now: Date,
): Promise<FlagRow | null> {
  const [row] = await db
    .insert(featureFlag)
    .values({ key, organizationId: org.value, ...patch, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: featureFlag.key,
      set: { ...patch, updatedAt: now },
      // Never once reclaimed: the decision is final.
      setWhere: and(eq(featureFlag.organizationId, org.value), isNull(featureFlag.reclaimedValue)),
    })
    .returning()
  return row ?? null
}

/**
 * The organizations named by id or slug, as ids. BAD_REQUEST names the ones that don't exist: the
 * operator addresses every organization, so saying which is missing leaks nothing.
 */
export async function resolveOrganizations<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: OperatorOrg<O>,
  refs: readonly string[],
): Promise<string[]> {
  const rows = await db
    .select({ id: organization.id, slug: organization.slug })
    .from(organization)
    .where(or(inArray(organization.id, [...refs]), inArray(organization.slug, [...refs])))
  const missing = refs.filter((ref) => !rows.some((r) => r.id === ref || r.slug === ref))
  if (missing.length > 0) {
    throw new AppError("BAD_REQUEST", `No organization with id or slug: ${missing.join(", ")}`, {
      hint: "Pass organization ids or slugs that exist. An organization's id is in its whoami.",
    })
  }
  return [...new Set(rows.map((r) => r.id))]
}

/** Set the target value for each organization (adding or changing it), and touch the rollout. */
export async function setTargets<K, O>(
  db: Database,
  key: Named<K, FeatureFlagKey>,
  org: Named<O, OrganizationId>,
  _proofs: { inOrg: FlagInOrg<K, O>; operator: OperatorOrg<O> },
  organizationIds: readonly string[],
  value: boolean,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(featureFlagTarget)
      .values(
        organizationIds.map((id) => ({
          organizationId: id,
          flagKey: key.value,
          value,
          createdAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [featureFlagTarget.organizationId, featureFlagTarget.flagKey],
        set: { value },
      })
    await touch(tx, key.value, org.value, now)
  })
}

/** Remove organizations from a rollout's targets; returns how many were targets. */
export async function removeTargets<K, O>(
  db: Database,
  key: Named<K, FeatureFlagKey>,
  org: Named<O, OrganizationId>,
  _proofs: { inOrg: FlagInOrg<K, O>; operator: OperatorOrg<O> },
  organizationIds: readonly string[],
  now: Date,
): Promise<number> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(featureFlagTarget)
      .where(
        and(
          eq(featureFlagTarget.flagKey, key.value),
          inArray(featureFlagTarget.organizationId, [...organizationIds]),
          // The proof's check again, so a stale proof can't edit another operator's rollout.
          inArray(
            featureFlagTarget.flagKey,
            tx
              .select({ key: featureFlag.key })
              .from(featureFlag)
              .where(eq(featureFlag.organizationId, org.value)),
          ),
        ),
      )
      .returning({ id: featureFlagTarget.organizationId })
    await touch(tx, key.value, org.value, now)
    return removed.length
  })
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

const touch = (tx: Tx, key: string, organizationId: string, now: Date) =>
  tx
    .update(featureFlag)
    .set({ updatedAt: now })
    .where(and(eq(featureFlag.key, key), eq(featureFlag.organizationId, organizationId)))

/** Fix the value every organization gets from now on. Null if it was reclaimed already. */
export async function reclaimRollout<K, O>(
  db: Database,
  key: Named<K, FeatureFlagKey>,
  org: Named<O, OrganizationId>,
  _proofs: { inOrg: FlagInOrg<K, O>; operator: OperatorOrg<O> },
  value: boolean,
  now: Date,
): Promise<FlagRow | null> {
  const [row] = await db
    .update(featureFlag)
    .set({ reclaimedValue: value, reclaimedAt: now, updatedAt: now })
    .where(
      and(
        eq(featureFlag.key, key.value),
        eq(featureFlag.organizationId, org.value),
        isNull(featureFlag.reclaimedValue),
      ),
    )
    .returning()
  return row ?? null
}

/** Delete a rollout and its targets. */
export async function deleteRollout<K, O>(
  db: Database,
  key: Named<K, FeatureFlagKey>,
  org: Named<O, OrganizationId>,
  _proofs: { inOrg: FlagInOrg<K, O>; operator: OperatorOrg<O> },
): Promise<void> {
  await db
    .delete(featureFlag)
    .where(and(eq(featureFlag.key, key.value), eq(featureFlag.organizationId, org.value)))
}

export interface ExposureCount {
  key: string
  day: string
  value: boolean
  count: number
  errors: number
}

/**
 * Add counted evaluations (and the errors that followed them). System-level, like loadRollouts:
 * the counts belong to no organization. Rows with nothing to add are skipped.
 */
export async function addExposures(db: Database, counts: readonly ExposureCount[]): Promise<void> {
  const rows = counts.filter((c) => c.count > 0 || c.errors > 0)
  if (rows.length === 0) return
  await db
    .insert(featureFlagExposureDaily)
    .values(
      rows.map((c) => ({
        flagKey: c.key,
        day: c.day,
        value: c.value,
        count: c.count,
        errors: c.errors,
      })),
    )
    .onConflictDoUpdate({
      target: [
        featureFlagExposureDaily.flagKey,
        featureFlagExposureDaily.day,
        featureFlagExposureDaily.value,
      ],
      set: {
        count: sql`${featureFlagExposureDaily.count} + excluded.count`,
        errors: sql`${featureFlagExposureDaily.errors} + excluded.errors`,
      },
    })
}

/** Exposures since `sinceDay` (inclusive), for the operator's stale signals and verify evidence. */
export function exposuresSince<O>(
  db: Database,
  _org: Named<O, OrganizationId>,
  _proof: OperatorOrg<O>,
  sinceDay: string,
  key?: string,
): Promise<ExposureCount[]> {
  return db
    .select({
      key: featureFlagExposureDaily.flagKey,
      day: featureFlagExposureDaily.day,
      value: featureFlagExposureDaily.value,
      count: featureFlagExposureDaily.count,
      errors: featureFlagExposureDaily.errors,
    })
    .from(featureFlagExposureDaily)
    .where(
      and(
        gte(featureFlagExposureDaily.day, sinceDay),
        key === undefined ? undefined : eq(featureFlagExposureDaily.flagKey, key),
      ),
    )
    .orderBy(asc(featureFlagExposureDaily.day))
}
