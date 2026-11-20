import { decodeCursor, encodeCursor } from "@proof/api"
import { AppError } from "@proof/errors"
import { z } from "zod"

import {
  type EntrySummary,
  type EntryVersionRow,
  editEntry,
  getEntry,
  getEntryHistory,
  listEntries,
  searchEntries,
} from "../data/entries"
import {
  defineOperation,
  entryBody,
  entryKind,
  type HqDeps,
  isoDate,
  requireFounder,
  title,
} from "./shared"

const author = z.object({
  type: z.enum(["person", "agent"]),
  id: z.string().describe("A user id, or an API key id"),
})

const summary = z.object({
  id: z.string(),
  kind: entryKind,
  slug: z.string(),
  version: z.number().int().describe("The newest version"),
  title: z.string(),
  createdAt: isoDate,
  updatedAt: isoDate.describe("When the newest version was written"),
})

const version = z.object({
  id: z.string().describe("The entry's id"),
  kind: entryKind,
  slug: z.string(),
  version: z.number().int(),
  latestVersion: z.number().int().describe("Use as baseVersion to propose or edit"),
  title: z.string(),
  body: entryBody,
  source: z.string().nullable().describe("Where it came from, e.g. proposal:<id>"),
  author,
  runId: z.string().nullable(),
  createdAt: isoDate,
})

const toSummary = (e: EntrySummary) => ({
  ...e,
  createdAt: e.createdAt.toISOString(),
  updatedAt: e.updatedAt.toISOString(),
})

const toVersion = (v: EntryVersionRow) => ({ ...v, createdAt: v.createdAt.toISOString() })

const entryCursor = z.object({ kind: entryKind, slug: z.string() })

function readEntryCursor(cursor: string | undefined) {
  if (cursor === undefined || cursor === "") return undefined
  const parsed = entryCursor.safeParse(decodeCursor(cursor))
  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid cursor", {
      hint: "Pass nextCursor from the previous page unchanged, or omit cursor to start from the first page.",
    })
  }
  return parsed.data
}

const ID = "00000000-0000-0000-0000-000000000000"

export function entryOperations(deps: HqDeps) {
  const { db, now } = deps

  const list_entries = defineOperation({
    name: "list_entries",
    method: "GET",
    path: "/v1/entries",
    summary: "List the brain's entries",
    description:
      "Returns entries (facts, voice, decisions, playbooks, customers) with their newest version's " +
      "title, ordered by kind then slug, one page at a time. Filter by kind, or by query (a " +
      "substring of the title or slug). Pass nextCursor back as cursor for the next page. Use " +
      "get_entry for the content, search_entries to search the text.",
    permissions: { hq_entry: ["read"] },
    input: z.object({
      kind: entryKind.optional(),
      query: z.string().trim().min(1).max(200).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    output: z.object({ entries: z.array(summary), nextCursor: z.string().nullable() }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: { kind: "fact" } }],
    handler: async (input) => {
      const rows = await listEntries(db, {
        kind: input.kind,
        query: input.query,
        after: readEntryCursor(input.cursor),
        limit: input.limit + 1,
      })
      const page = rows.slice(0, input.limit)
      const last = page.at(-1)
      const nextCursor =
        rows.length > input.limit && last
          ? encodeCursor({ kind: last.kind, slug: last.slug })
          : null
      return { entries: page.map(toSummary), nextCursor }
    },
  })

  const get_entry = defineOperation({
    name: "get_entry",
    method: "GET",
    path: "/v1/entries/:id",
    summary: "Read an entry, its newest version or a given one",
    description:
      "Returns the entry's content at its newest version, or at `version` when given. " +
      "`latestVersion` is the number to pass as baseVersion when you propose a change. Older " +
      "versions stay readable forever. get_entry_history lists them all.",
    permissions: { hq_entry: ["read"] },
    input: z.object({
      id: z.string(),
      version: z.coerce.number().int().min(1).optional(),
    }),
    output: version,
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: { id: ID }, error: "NOT_FOUND" }],
    handler: (input) => getEntry(db, input.id, input.version).then(toVersion),
  })

  const get_entry_history = defineOperation({
    name: "get_entry_history",
    method: "GET",
    path: "/v1/entries/:id/history",
    summary: "List every version of an entry with its author",
    description:
      "Returns all versions of the entry, oldest first, each with who wrote it (a person or an " +
      "agent, and the run) and where it came from. Nothing is ever deleted, so this is the full " +
      "record of how the entry changed.",
    permissions: { hq_entry: ["read"] },
    input: z.object({ id: z.string() }),
    output: z.object({ versions: z.array(version) }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: { id: ID }, error: "NOT_FOUND" }],
    handler: async (input) => ({
      versions: (await getEntryHistory(db, input.id)).map(toVersion),
    }),
  })

  const search_entries = defineOperation({
    name: "search_entries",
    method: "POST",
    path: "/v1/search/entries",
    summary: "Search the newest version of every entry",
    description:
      "Full-text search over each entry's title, slug and text, best match first. `query` takes " +
      "plain words, quoted phrases and `-exclusions`. Narrow with kinds. Read-only, though it is a " +
      "POST so the kinds list fits in the body. Returns an excerpt; get_entry returns the rest.",
    permissions: { hq_entry: ["read"] },
    input: z.object({
      query: z.string().trim().min(1).max(200),
      kinds: z.array(entryKind).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    output: z.object({ hits: z.array(summary.extend({ excerpt: z.string() })) }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: { query: "pricing" } }],
    handler: async (input) => ({
      hits: (await searchEntries(db, input)).map((hit) => ({
        ...toSummary(hit),
        excerpt: hit.excerpt,
      })),
    }),
  })

  const edit_entry = defineOperation({
    name: "edit_entry",
    method: "POST",
    path: "/v1/entries/:id/versions",
    summary: "Write a new version of an entry (a founder's edit)",
    description:
      "A founder edits an entry directly: this adds version baseVersion + 1 and keeps every older " +
      "version. baseVersion is the version you read (latestVersion from get_entry); if the entry " +
      "has moved on, CONFLICT and nothing is saved. Only a signed-in founder can edit: API keys and " +
      "AI clients propose with propose_entry instead. Confirm the change with the user first.",
    permissions: { hq_entry: ["update"] },
    input: z.object({
      id: z.string(),
      title,
      body: entryBody,
      baseVersion: z.number().int().min(1),
    }),
    output: version,
    hints: { readOnly: false, destructive: false },
    examples: [
      {
        input: { id: ID, title: "Pricing", body: { text: "Free, then $20." }, baseVersion: 1 },
        error: "NOT_FOUND",
      },
    ],
    handler: async (input, { caller }) => {
      const founderId = await requireFounder(deps, caller)
      return toVersion(
        await editEntry(db, {
          ...input,
          author: { type: "person", id: founderId },
          now: now(),
        }),
      )
    },
  })

  return [list_entries, get_entry, get_entry_history, search_entries, edit_entry] as const
}
