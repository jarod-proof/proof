// Maintenance: deletes rows that can no longer matter. Run by `pnpm --filter @proof/api-app cleanup`
// (apps/api/src/cleanup.ts), never by a request.
//
// These queries are cross-tenant on purpose. There is no caller and no organization to prove, so
// they take no gdp-ts proof (like organizationClaimed in ./organizations.ts). Nothing in the
// operation registry calls them, and the only caller is the cleanup entry.
import {
  createDb,
  type Database,
  featureFlagExposureDaily,
  idempotencyKey,
  signupAttempt,
  verification,
} from "@proof/db"
import { and, inArray, like, lt } from "drizzle-orm"

export const CLEANUP_BATCH_SIZE = 1000

/**
 * Signup attempts older than this are deleted. signup.ts counts attempts over one hour (per IP) and
 * one day (per email domain); its HOUR_MS and DAY_MS are not exported, so this is coupled to them by
 * hand. Keep the margin above the longest window. Change this if signup.ts's windows change.
 */
export const SIGNUP_RETENTION_MS = 25 * 60 * 60 * 1000

/**
 * Flag exposure days older than this are deleted. The stale signals look back 30 days
 * (INACTIVE_DAYS in @proof/flags); the margin keeps a quarter of history for a reclaim decision.
 */
export const EXPOSURE_RETENTION_DAYS = 90

/** Verification identifiers written by the device grant for an approved code (see device.ts). */
const DEVICE_ORG_PREFIX = "device-org:"

export interface PruneCounts {
  signupAttempts: number
  idempotencyKeys: number
  deviceOrgVerifications: number
  flagExposureDays: number
}

export interface PruneOptions {
  /** Rows deleted per statement. Each statement is short, so one run doesn't hold locks long. */
  batchSize?: number
}

/**
 * Delete one batch at a time (`DELETE ... WHERE id IN (SELECT id ... LIMIT n)`) until a batch comes
 * back short, so a large backlog never becomes one long statement.
 */
async function deleteInBatches(
  batchSize: number,
  deleteBatch: (limit: number) => Promise<{ length: number }>,
): Promise<number> {
  let total = 0
  for (;;) {
    const deleted = (await deleteBatch(batchSize)).length
    total += deleted
    if (deleted < batchSize) return total
  }
}

/** Remove expired rows from the tables that only accumulate. Live rows are never touched. */
export async function pruneExpired(
  db: Database,
  now: Date = new Date(),
  options: PruneOptions = {},
): Promise<PruneCounts> {
  const batchSize = options.batchSize ?? CLEANUP_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("batchSize must be a positive integer")
  }

  const signupCutoff = new Date(now.getTime() - SIGNUP_RETENTION_MS)
  const signupAttempts = await deleteInBatches(batchSize, (limit) =>
    db
      .delete(signupAttempt)
      .where(
        inArray(
          signupAttempt.id,
          db
            .select({ id: signupAttempt.id })
            .from(signupAttempt)
            .where(lt(signupAttempt.createdAt, signupCutoff))
            .limit(limit),
        ),
      )
      .returning({ id: signupAttempt.id }),
  )

  // Completed keys live 24 hours and reservations 5 minutes (idempotency.ts). A reservation past its
  // lease is already reclaimable by the next reserve, so deleting it here changes nothing for callers.
  const idempotencyKeys = await deleteInBatches(batchSize, (limit) =>
    db
      .delete(idempotencyKey)
      .where(
        inArray(
          idempotencyKey.id,
          db
            .select({ id: idempotencyKey.id })
            .from(idempotencyKey)
            .where(lt(idempotencyKey.expiresAt, now))
            .limit(limit),
        ),
      )
      .returning({ id: idempotencyKey.id }),
  )

  const deviceOrgVerifications = await deleteInBatches(batchSize, (limit) =>
    db
      .delete(verification)
      .where(
        inArray(
          verification.id,
          db
            .select({ id: verification.id })
            .from(verification)
            .where(
              and(
                like(verification.identifier, `${DEVICE_ORG_PREFIX}%`),
                lt(verification.expiresAt, now),
              ),
            )
            .limit(limit),
        ),
      )
      .returning({ id: verification.id }),
  )

  // One row per flag, value and day: few enough to delete in one statement.
  const exposureCutoff = new Date(now.getTime() - EXPOSURE_RETENTION_DAYS * 86_400_000)
  const flagExposureDays = (
    await db
      .delete(featureFlagExposureDaily)
      .where(lt(featureFlagExposureDaily.day, exposureCutoff.toISOString().slice(0, 10)))
      .returning({ key: featureFlagExposureDaily.flagKey })
  ).length

  return { signupAttempts, idempotencyKeys, deviceOrgVerifications, flagExposureDays }
}

/** Open the database at `databaseUrl` and prune once. The cleanup entry calls this with the env URL. */
export function runCleanup(databaseUrl: string, now: Date = new Date()): Promise<PruneCounts> {
  return pruneExpired(createDb(databaseUrl), now)
}
