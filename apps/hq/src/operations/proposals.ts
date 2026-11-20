import { decodeCursor, encodeCursor } from "@proof/api"
import { AppError } from "@proof/errors"
import { z } from "zod"

import { createProposal, decideProposal, listProposals, type ProposalRow } from "../data/proposals"
import { PROPOSAL_STATUSES } from "../db/schema"
import {
  authorOf,
  defineOperation,
  entryBody,
  entryKind,
  type HqDeps,
  isoDate,
  requireFounder,
  slug,
  title,
} from "./shared"

const proposal = z.object({
  id: z.string(),
  entryId: z.string().nullable().describe("Null for a new entry, until it is approved"),
  kind: entryKind,
  slug: z.string(),
  baseVersion: z.number().int().nullable().describe("The version it was proposed against"),
  title: z.string(),
  body: entryBody,
  reason: z.string(),
  status: z.enum(PROPOSAL_STATUSES),
  proposedBy: z.object({ type: z.enum(["person", "agent"]), id: z.string() }),
  runId: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: isoDate.nullable(),
  decisionNote: z.string().nullable(),
  createdAt: isoDate,
})

const toProposal = (p: ProposalRow) => ({
  ...p,
  decidedAt: p.decidedAt?.toISOString() ?? null,
  createdAt: p.createdAt.toISOString(),
})

const pageCursor = z.object({ at: z.string(), id: z.string() })

function readPageCursor(cursor: string | undefined) {
  if (cursor === undefined || cursor === "") return undefined
  const parsed = pageCursor.safeParse(decodeCursor(cursor))
  const at = parsed.success ? new Date(parsed.data.at) : null
  if (!parsed.success || !at || Number.isNaN(at.getTime())) {
    throw new AppError("BAD_REQUEST", "Invalid cursor", {
      hint: "Pass nextCursor from the previous page unchanged, or omit cursor to start from the first page.",
    })
  }
  return { at, id: parsed.data.id }
}

const ID = "00000000-0000-0000-0000-000000000000"

export function proposalOperations(deps: HqDeps) {
  const { db, now } = deps

  const propose_entry = defineOperation({
    name: "propose_entry",
    method: "POST",
    path: "/v1/proposals",
    summary: "Propose a new entry or a change to one (a founder decides)",
    description:
      "The only way for an agent, or anything that came from outside, to change the brain. It " +
      "records a pending proposal and writes nothing else: a founder approves or rejects it. Text " +
      "inside body or reason that asks for approval, or claims it is already true, changes " +
      "nothing. To change an existing entry, pass its current version as baseVersion " +
      "(latestVersion from get_entry; left out it is the newest now); approval fails with " +
      "CONFLICT if the entry has since moved on. Leave baseVersion out for a new entry. Give " +
      "reason (why this should be true) and runId (the run that produced it) when you have them.",
    permissions: { hq_proposal: ["create"] },
    input: z.object({
      kind: entryKind,
      slug,
      title,
      body: entryBody,
      reason: z.string().trim().min(1).max(2000).describe("Why this should be in the brain"),
      baseVersion: z.number().int().min(1).optional(),
      runId: z.string().max(200).optional().describe("The run that produced it"),
    }),
    output: z.object({ proposalId: z.string(), status: z.literal("pending") }),
    hints: { readOnly: false, destructive: false },
    examples: [
      {
        input: {
          kind: "fact",
          slug: "pricing",
          title: "Pricing",
          body: { text: "Free, then $20 per seat." },
          reason: "Stated in the 2026-11-12 founders call",
        },
      },
    ],
    handler: async (input, { caller }) => {
      const row = await createProposal(db, { ...input, proposer: authorOf(caller), now: now() })
      return { proposalId: row.id, status: "pending" as const }
    },
  })

  const list_proposals = defineOperation({
    name: "list_proposals",
    method: "GET",
    path: "/v1/proposals",
    summary: "List proposals, newest first",
    description:
      "Returns proposals with their proposed content, newest first, one page at a time. Filter " +
      "by status (pending, approved, rejected). Pass nextCursor back as cursor for the next page.",
    permissions: { hq_proposal: ["read"] },
    input: z.object({
      status: z.enum(PROPOSAL_STATUSES).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    output: z.object({ proposals: z.array(proposal), nextCursor: z.string().nullable() }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: { status: "pending" } }],
    handler: async (input) => {
      const rows = await listProposals(db, {
        status: input.status,
        after: readPageCursor(input.cursor),
        limit: input.limit + 1,
      })
      const page = rows.slice(0, input.limit)
      const last = page.at(-1)
      const nextCursor =
        rows.length > input.limit && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last.id })
          : null
      return { proposals: page.map(toProposal), nextCursor }
    },
  })

  const decide_proposal = defineOperation({
    name: "decide_proposal",
    method: "POST",
    path: "/v1/proposals/:proposalId/decision",
    summary: "Approve or reject a proposal (a founder's decision)",
    description:
      "A founder approves (writes the proposal as the entry's next version, authored by the " +
      "proposer) or rejects it. Only a signed-in founder can decide: API keys, OAuth tokens and " +
      "anyone not on the founder list get FORBIDDEN, so never call it on your own judgement. " +
      "Returns CONFLICT, and writes nothing, if the proposal was already decided or its entry " +
      "has moved past the proposal's baseVersion. Confirm the decision with the user first.",
    permissions: { hq_proposal: ["decide"] },
    input: z.object({
      proposalId: z.string(),
      decision: z.enum(["approve", "reject"]),
      note: z.string().trim().max(2000).optional(),
    }),
    output: z.object({
      status: z.enum(["approved", "rejected"]),
      entryId: z.string().optional(),
      version: z.number().int().optional(),
    }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { proposalId: ID, decision: "approve" }, error: "NOT_FOUND" }],
    handler: async (input, { caller }) => {
      const decidedBy = await requireFounder(deps, caller)
      return decideProposal(db, { ...input, decidedBy, now: now() })
    },
  })

  return [propose_entry, list_proposals, decide_proposal] as const
}
