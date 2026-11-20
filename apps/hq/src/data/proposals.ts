// Proposals: the only way an agent or an outside write reaches the brain (the trust rule). A
// proposal changes nothing until a founder approves it; approving writes a new version.
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, desc, eq, lt, or } from "drizzle-orm"

import {
  type AuthorType,
  type EntryBody,
  type EntryKind,
  type ProposalStatus,
  proposals,
} from "../db/schema"
import {
  type Author,
  appendVersion,
  createEntry,
  findEntry,
  latestVersionNumber,
  lockEntry,
} from "./entries"

export interface ProposalRow {
  id: string
  entryId: string | null
  kind: EntryKind
  slug: string
  baseVersion: number | null
  title: string
  body: EntryBody
  reason: string
  status: ProposalStatus
  proposedBy: Author
  runId: string | null
  decidedBy: string | null
  decidedAt: Date | null
  decisionNote: string | null
  createdAt: Date
}

type Stored = typeof proposals.$inferSelect

const toRow = (p: Stored): ProposalRow => ({
  id: p.id,
  entryId: p.entryId,
  kind: p.kind,
  slug: p.slug,
  baseVersion: p.baseVersion,
  title: p.title,
  body: p.body,
  reason: p.reason,
  status: p.status,
  proposedBy: { type: p.proposedByType satisfies AuthorType, id: p.proposedById },
  runId: p.runId,
  decidedBy: p.decidedBy,
  decidedAt: p.decidedAt,
  decisionNote: p.decisionNote,
  createdAt: p.createdAt,
})

/**
 * Record a proposal, always `pending`: nothing here writes an entry, whoever proposes and
 * whatever the text says. For an existing entry, `baseVersion` is the version the proposer read
 * (the entry's newest when left out); approval fails with CONFLICT if the entry has moved on.
 */
export async function createProposal(
  db: Database,
  input: {
    kind: EntryKind
    slug: string
    title: string
    body: EntryBody
    reason: string
    baseVersion?: number
    runId?: string
    proposer: Author
    now: Date
  },
): Promise<ProposalRow> {
  const entry = await findEntry(db, input.kind, input.slug)
  let entryId: string | null = null
  let baseVersion: number | null = null
  if (entry) {
    const latest = await latestVersionNumber(db, entry.id)
    if (input.baseVersion !== undefined && input.baseVersion > latest) {
      throw new AppError(
        "BAD_REQUEST",
        `The entry is at version ${latest}, not ${input.baseVersion}`,
      )
    }
    entryId = entry.id
    baseVersion = input.baseVersion ?? latest
  } else if (input.baseVersion !== undefined) {
    throw new AppError("BAD_REQUEST", `There is no ${input.kind} entry "${input.slug}" yet`, {
      hint: "Leave baseVersion out to propose a new entry.",
    })
  }
  const [row] = await db
    .insert(proposals)
    .values({
      id: crypto.randomUUID(),
      entryId,
      kind: input.kind,
      slug: input.slug,
      baseVersion,
      title: input.title,
      body: input.body,
      reason: input.reason,
      status: "pending",
      proposedByType: input.proposer.type,
      proposedById: input.proposer.id,
      runId: input.runId ?? null,
      createdAt: input.now,
    })
    .returning()
  if (!row) throw new AppError("INTERNAL", "insert returned no row")
  return toRow(row)
}

export async function getProposal(db: Database, id: string): Promise<ProposalRow> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, id))
  if (!row) throw new AppError("NOT_FOUND", "Proposal not found")
  return toRow(row)
}

/** Newest first, one page after `after`. */
export async function listProposals(
  db: Database,
  opts: { status?: ProposalStatus; after?: { at: Date; id: string }; limit: number },
): Promise<ProposalRow[]> {
  const { after } = opts
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        opts.status ? eq(proposals.status, opts.status) : undefined,
        after
          ? or(
              lt(proposals.createdAt, after.at),
              and(eq(proposals.createdAt, after.at), lt(proposals.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
    .limit(opts.limit)
  return rows.map(toRow)
}

export interface Decision {
  status: "approved" | "rejected"
  entryId?: string
  version?: number
}

/**
 * A founder's decision, in one transaction that locks the proposal (and, to approve, the entry).
 * Approving writes a new version authored by the proposer (source `proposal:<id>`); the founder
 * is recorded on the proposal. Refused with CONFLICT, and nothing written, when the proposal was
 * already decided or its entry moved past `baseVersion` since it was proposed.
 */
export function decideProposal(
  db: Database,
  input: {
    proposalId: string
    decision: "approve" | "reject"
    note?: string
    decidedBy: string
    now: Date
  },
): Promise<Decision> {
  return db.transaction(async (tx) => {
    const [stored] = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.id, input.proposalId))
      .for("update")
    if (!stored) throw new AppError("NOT_FOUND", "Proposal not found")
    if (stored.status !== "pending") {
      throw new AppError("CONFLICT", `The proposal was already ${stored.status}`, {
        hint: "A decided proposal is final. Propose again to change the entry.",
      })
    }
    const decided = {
      decidedBy: input.decidedBy,
      decidedAt: input.now,
      decisionNote: input.note ?? null,
    }

    if (input.decision === "reject") {
      await tx
        .update(proposals)
        .set({ status: "rejected", ...decided })
        .where(eq(proposals.id, stored.id))
      return { status: "rejected" }
    }

    let entryId: string
    let version: number
    if (stored.entryId) {
      const entry = await lockEntry(tx, stored.entryId)
      if (!entry) throw new AppError("NOT_FOUND", "Entry not found")
      const latest = await latestVersionNumber(tx, entry.id)
      if (latest !== stored.baseVersion) {
        throw new AppError(
          "CONFLICT",
          `The entry is at version ${latest} but the proposal was made against ` +
            `${stored.baseVersion}: nothing was written`,
          { hint: "Reject it, or ask the proposer to propose again against the current version." },
        )
      }
      entryId = entry.id
      version = latest + 1
    } else {
      // A new entry: if one took the slug since, the proposal was made without knowing it.
      entryId = await createEntry(tx, { kind: stored.kind, slug: stored.slug, now: input.now })
      version = 1
    }
    await appendVersion(tx, {
      entryId,
      version,
      title: stored.title,
      body: stored.body,
      source: `proposal:${stored.id}`,
      author: { type: stored.proposedByType, id: stored.proposedById },
      runId: stored.runId,
      now: input.now,
    })
    await tx
      .update(proposals)
      .set({ status: "approved", entryId, ...decided })
      .where(eq(proposals.id, stored.id))
    return { status: "approved", entryId, version }
  })
}
