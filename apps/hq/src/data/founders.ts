import type { Caller } from "@proof/api"
import { type Database, member, user } from "@proof/db"
import { and, count, eq, inArray, or, sql } from "drizzle-orm"

import { founders } from "../db/schema"

/**
 * Who the founders are: the rows of `hq.founders`, and nothing else. Every check (a session decides
 * a proposal, a key's owner reaches hq, a Slack click is mapped to a person) reads this table. hq's
 * sign-up is closed by default and open sign-up would make a stranger a person with a session, so
 * being signed in makes no one a founder.
 *
 * How a row is created: `syncFounders`, from HQ_FOUNDERS. A local hq runs it at boot; a deployed
 * hq's `pnpm hq:predeploy` runs it at deploy time and the deployed boot only checks the table
 * against its list (`verifyFounders`). There is no operation, route or page that writes the
 * table, so no key and no unauthenticated caller can add a founder. The one other writer is
 * `create-founder` (a command run on the server, `addFounder`): run against a deployed hq it adds
 * a row HQ_FOUNDERS does not list yet, so new instances refuse (a deployed boot sees a row its
 * list lacks) until the entry is added to HQ_FOUNDERS, predeploy runs and hq is redeployed. To add or remove a founder,
 * change HQ_FOUNDERS and restart a local hq, or redeploy (predeploy first) a deployed one: the
 * table is set to match the list.
 */

/** A Slack user id: `U` or `W` and capitals or digits. */
export const SLACK_USER_ID = /^[UW][A-Z0-9]+$/

/** One entry of HQ_FOUNDERS: who (by verified email, or user id) and their Slack user. */
export interface FounderSeed {
  who: { email: string } | { userId: string }
  slackUserId: string
}

/**
 * Parse HQ_FOUNDERS: comma-separated `<email>=<slack user id>` or `id:<user id>=<slack user id>`.
 * Empty or unset is no founders. A malformed entry, a repeated person or a repeated Slack user
 * throws: a founder list that is half understood must stop hq, never quietly shrink.
 */
export function parseFounders(value: string | undefined): FounderSeed[] {
  const seeds: FounderSeed[] = []
  const seen = new Set<string>()
  const slackSeen = new Set<string>()
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim()
    if (entry === "") continue
    const at = entry.lastIndexOf("=")
    const left = at === -1 ? "" : entry.slice(0, at).trim()
    const slackUserId = at === -1 ? "" : entry.slice(at + 1).trim()
    if (left === "" || !SLACK_USER_ID.test(slackUserId)) {
      throw new Error(
        `HQ_FOUNDERS: "${entry}" is not <email>=<slack user id> or id:<user id>=<slack user id>`,
      )
    }
    const who = left.startsWith("id:")
      ? { userId: left.slice(3).trim() }
      : { email: left.toLowerCase() }
    const identity = "userId" in who ? `id:${who.userId}` : who.email
    if (identity === "id:" || seen.has(identity) || slackSeen.has(slackUserId)) {
      throw new Error(`HQ_FOUNDERS: "${entry}" repeats a person or a Slack user`)
    }
    seen.add(identity)
    slackSeen.add(slackUserId)
    seeds.push({ who, slackUserId })
  }
  return seeds
}

/**
 * A listed person who could not be resolved to a usable account. Names the entry's place in the
 * list and its kind, never the email or id itself: this goes in logs, and an address is personal.
 */
export interface SkippedFounder {
  /** The entry's place in HQ_FOUNDERS, from 1. */
  entry: number
  kind: "email" | "id"
  why: string
}

export interface FounderSync {
  /** User ids now in the table that were not before. */
  added: string[]
  /** User ids taken out because they are no longer listed (or no longer qualify). */
  removed: string[]
  /** Listed people who could not be resolved to a usable account, with why. */
  skipped: SkippedFounder[]
}

export interface FounderSyncOptions {
  /**
   * A deployed hq: only an entry pinned by user id (`id:<user id>=<slack user id>`, the id
   * `create-founder` prints) can make a founder. An email entry matches whoever holds that address,
   * and an account made by public sign-up and verified through its emailed link is not the
   * founder's, so a deployed hq never trusts one. Default false: local and e2e stacks seed founders
   * by the address they sign up with.
   */
  pinnedOnly?: boolean
}

/** A database or the transaction on it: what a read of the founders needs. */
type Reader = Pick<Database, "select">

/**
 * Who the list resolves to right now, and what is in the table: the one reading `syncFounders`
 * writes from and `verifyFounders` compares against, so the two cannot disagree about the list.
 * A listed person counts only as an existing, unbanned account whose address is verified (anyone
 * can sign up with an address they don't own), and, with `pinnedOnly`, only one named by id.
 */
async function resolveSeeds(
  db: Reader,
  seeds: readonly FounderSeed[],
  options: FounderSyncOptions,
) {
  const wanted = new Map<string, string>()
  const skipped: SkippedFounder[] = []
  for (const [index, seed] of seeds.entries()) {
    const pinned = "userId" in seed.who
    const entry = { entry: index + 1, kind: pinned ? ("id" as const) : ("email" as const) }
    if (!pinned && options.pinnedOnly) {
      skipped.push({
        ...entry,
        why: "a deployed hq takes founders by id only: run create-founder, then list id:<user id>",
      })
      continue
    }
    const [row] = await db
      .select({ id: user.id, verified: user.emailVerified, banned: user.banned })
      .from(user)
      .where("userId" in seed.who ? eq(user.id, seed.who.userId) : eq(user.email, seed.who.email))
    if (!row) skipped.push({ ...entry, why: "no such account yet" })
    else if (row.banned) skipped.push({ ...entry, why: "account is banned" })
    else if (!row.verified) skipped.push({ ...entry, why: "the address is not verified" })
    else wanted.set(row.id, seed.slackUserId)
  }
  return { wanted, skipped }
}

/** `resolveSeeds` and the table, for the two that compare them: sync and verify. */
async function readPlan(db: Reader, seeds: readonly FounderSeed[], options: FounderSyncOptions) {
  const { wanted, skipped } = await resolveSeeds(db, seeds, options)
  return { wanted, skipped, existing: await db.select().from(founders) }
}

/**
 * Who the list resolves to right now, without reading or writing the table: the founders a sync of
 * this list would leave (user id -> Slack user) and the entries it would skip. Predeploy builds the
 * agent's founder list from this before it writes anything, so a refused deploy changes nothing.
 */
export async function planFounders(
  db: Database,
  seeds: readonly FounderSeed[],
  options: FounderSyncOptions = {},
): Promise<{ wanted: ReadonlyMap<string, string>; skipped: SkippedFounder[] }> {
  return resolveSeeds(db, seeds, options)
}

/**
 * Set the table to match the list. Rows for anyone not resolved are deleted, so removing a founder
 * from HQ_FOUNDERS removes them at the next sync, and an empty list leaves no founders: it fails
 * closed. In one transaction, and one at a time across processes.
 *
 * Who calls it: a local or e2e hq at every boot (`prepareBoot`), and a deployed hq's
 * `pnpm hq:predeploy` at deploy time (`publishFounders`). A deployed hq's own boot never writes
 * (`verifyFounders`): an older deployment that is still reachable must not put back a founder the
 * newest deployment removed.
 */
export function syncFounders(
  db: Database,
  seeds: readonly FounderSeed[],
  now: Date,
  options: FounderSyncOptions = {},
): Promise<FounderSync> {
  return db.transaction(async (tx) => {
    // Several processes can sync at once (two deploys, or local instances). One transaction is not
    // enough: at READ COMMITTED two of them both read the table, both compute their changes from
    // that same stale read and both insert, so the second hits the primary key or the
    // slack_user_id unique constraint; and two different lists could leave a table that matches
    // neither. A transaction-scoped advisory lock makes the syncs run one after another: the next
    // one takes the lock only after the previous commits and then reads the committed table, so it
    // computes against the truth (usually no change). The deletes and inserts below are in this
    // transaction, so no reader sees a founder missing in between. `_xact_` releases at commit or
    // rollback, so a crashed process cannot leave it held, and it holds through a pooled
    // (transaction-mode) connection because the whole sync is one transaction. It relies on READ
    // COMMITTED (Postgres's default): at REPEATABLE READ the snapshot is taken before the wait.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('hq.founders.sync', 0))`)
    const { wanted, skipped, existing } = await readPlan(tx, seeds, options)
    const removed = existing.filter((f) => !wanted.has(f.userId)).map((f) => f.userId)
    if (removed.length > 0) await tx.delete(founders).where(inArray(founders.userId, removed))
    const changed = [...wanted].filter(
      ([userId, slackUserId]) =>
        existing.find((f) => f.userId === userId)?.slackUserId !== slackUserId,
    )
    if (changed.length > 0) {
      // A Slack user can move from one person to another in one pass: clear every row this
      // touches, then write the new ones.
      await tx.delete(founders).where(
        or(
          inArray(
            founders.userId,
            changed.map(([userId]) => userId),
          ),
          inArray(
            founders.slackUserId,
            changed.map(([, slackUserId]) => slackUserId),
          ),
        ),
      )
      await tx
        .insert(founders)
        .values(changed.map(([userId, slackUserId]) => ({ userId, slackUserId, createdAt: now })))
    }
    const added = changed
      .map(([userId]) => userId)
      .filter((userId) => !existing.some((f) => f.userId === userId))
    return { added, removed, skipped }
  })
}

/** What `verifyFounders` found. Counts and kinds only: this goes in logs. */
export interface FounderVerification {
  /** The table is exactly what `syncFounders` would leave for this list. */
  current: boolean
  /** Founders this list has that the table lacks, or has with another Slack user. */
  missing: number
  /** Founders in the table that this list does not have. */
  extra: number
  skipped: SkippedFounder[]
}

/**
 * Read-only: does the table equal what `syncFounders` would write for this list right now? A
 * deployed hq boots on this and serves only when it does. It never writes, so a deployment that
 * is not the newest cannot change who the founders are: only the newest deploy's
 * `publishFounders` does, and an older deployment then finds the table differs from its own list
 * and refuses to serve. One snapshot, so a sync committing between its reads cannot make it
 * compare half of each.
 */
export function verifyFounders(
  db: Database,
  seeds: readonly FounderSeed[],
  options: FounderSyncOptions = {},
): Promise<FounderVerification> {
  return db.transaction(
    async (tx) => {
      const { wanted, skipped, existing } = await readPlan(tx, seeds, options)
      const missing = [...wanted].filter(
        ([userId, slackUserId]) =>
          existing.find((f) => f.userId === userId)?.slackUserId !== slackUserId,
      ).length
      const extra = existing.filter((f) => !wanted.has(f.userId)).length
      return { current: missing === 0 && extra === 0, missing, extra, skipped }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  )
}

/** Insert one founder row. What `syncFounders` does per person; tests use it to stand one up. */
export async function addFounder(
  db: Database,
  input: { userId: string; slackUserId: string; now: Date },
): Promise<void> {
  await db
    .insert(founders)
    .values({ userId: input.userId, slackUserId: input.slackUserId, createdAt: input.now })
    .onConflictDoUpdate({ target: founders.userId, set: { slackUserId: input.slackUserId } })
}

/** Whether this user is a founder: a row in the table, for an account that exists and is not banned. */
export async function isFounder(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: founders.userId })
    .from(founders)
    .innerJoin(user, eq(user.id, founders.userId))
    .where(and(eq(founders.userId, userId), sql`${user.banned} is not true`))
  return row !== undefined
}

/** How many founders hq has: the rows of the table whose account exists and is not banned. */
export async function countFounders(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(founders)
    .innerJoin(user, eq(user.id, founders.userId))
    .where(sql`${user.banned} is not true`)
  return Number(row?.n ?? 0)
}

/** The founder a Slack user is, or null: the mapping a click is decided under. */
export async function founderForSlackUser(
  db: Database,
  slackUserId: string,
): Promise<{ userId: string } | null> {
  const [row] = await db
    .select({ userId: founders.userId })
    .from(founders)
    .innerJoin(user, eq(user.id, founders.userId))
    .where(and(eq(founders.slackUserId, slackUserId), sql`${user.banned} is not true`))
  return row ?? null
}

/** Every founder's Slack user id, in a stable order: what the agent's founder list is derived from. */
export async function founderSlackUserIds(db: Database): Promise<string[]> {
  const rows = await db
    .select({ slackUserId: founders.slackUserId })
    .from(founders)
    .innerJoin(user, eq(user.id, founders.userId))
    .where(sql`${user.banned} is not true`)
  return rows.map((r) => r.slackUserId).sort()
}

/**
 * Whether a caller may use hq at all. The brain holds private facts and customers, so every caller
 * must trace back to a founder:
 *  - a person (a session, or an OAuth token they granted) must be a founder;
 *  - an API key acts for an organization, so the organization must be owned by a founder.
 */
export async function mayUseHq(
  db: Database,
  caller: Pick<Caller, "via" | "actor" | "organizationId">,
): Promise<boolean> {
  if (caller.actor.type === "user") return isFounder(db, caller.actor.userId)
  const owners = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, caller.organizationId), eq(member.role, "owner")))
  for (const owner of owners) if (await isFounder(db, owner.userId)) return true
  return false
}
