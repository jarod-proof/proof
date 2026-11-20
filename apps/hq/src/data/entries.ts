// The brain's entries and their versions. Every query on hq's tables lives in src/data. The
// history rule is kept here: a version is only ever inserted, never updated or deleted (the
// database refuses both too, see drizzle/0001_entry_versions_append_only.sql).
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, asc, desc, eq, gt, ilike, inArray, max, or, sql } from "drizzle-orm"

import {
  type AuthorType,
  type EntryBody,
  type EntryKind,
  entries,
  entryVersions,
} from "../db/schema"

/** Who wrote a version: a person (a signed-in founder) or an agent (a key, an AI client). */
export interface Author {
  type: AuthorType
  id: string
}

/** One version of an entry, with the entry's identity. */
export interface EntryVersionRow {
  id: string
  kind: EntryKind
  slug: string
  version: number
  /** The newest version the entry has now, so a reader of an old one knows its baseVersion. */
  latestVersion: number
  title: string
  body: EntryBody
  source: string | null
  author: Author
  runId: string | null
  createdAt: Date
}

/** An entry as the lists show it: its newest version, without the body. */
export interface EntrySummary {
  id: string
  kind: EntryKind
  slug: string
  version: number
  title: string
  createdAt: Date
  updatedAt: Date
}

export interface SearchHit extends EntrySummary {
  excerpt: string
}

export const isUniqueViolation = (error: unknown): boolean => {
  const code = (e: unknown) => (typeof e === "object" && e !== null ? Reflect.get(e, "code") : null)
  const cause = typeof error === "object" && error !== null ? Reflect.get(error, "cause") : null
  return code(error) === "23505" || code(cause) === "23505"
}

/** The newest version number of an entry, 0 when it has none. */
export async function latestVersionNumber(db: Database, entryId: string): Promise<number> {
  const [row] = await db
    .select({ latest: max(entryVersions.version) })
    .from(entryVersions)
    .where(eq(entryVersions.entryId, entryId))
  return row?.latest ?? 0
}

/** Lock an entry's row for the rest of the transaction, so version numbers can't race. */
export async function lockEntry(db: Database, id: string) {
  const [entry] = await db.select().from(entries).where(eq(entries.id, id)).for("update")
  return entry ?? null
}

/** Add a version. The only write to `entry_versions`. */
export async function appendVersion(
  db: Database,
  input: {
    entryId: string
    version: number
    title: string
    body: EntryBody
    source: string | null
    author: Author
    runId: string | null
    now: Date
  },
): Promise<void> {
  await db.insert(entryVersions).values({
    id: crypto.randomUUID(),
    entryId: input.entryId,
    version: input.version,
    title: input.title,
    body: input.body,
    source: input.source,
    authorType: input.author.type,
    authorId: input.author.id,
    runId: input.runId,
    createdAt: input.now,
  })
}

/** A new entry (identity only; the caller adds version 1). CONFLICT when the slug is taken. */
export async function createEntry(
  db: Database,
  input: { kind: EntryKind; slug: string; now: Date },
): Promise<string> {
  const id = crypto.randomUUID()
  try {
    await db
      .insert(entries)
      .values({ id, kind: input.kind, slug: input.slug, createdAt: input.now })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    throw new AppError("CONFLICT", `A ${input.kind} entry "${input.slug}" already exists`, {
      hint: "Propose a change to the existing entry with its current baseVersion instead.",
    })
  }
  return id
}

export async function findEntry(db: Database, kind: EntryKind, slug: string) {
  const [entry] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.kind, kind), eq(entries.slug, slug)))
  return entry ?? null
}

const versionColumns = {
  id: entryVersions.id,
  entryId: entryVersions.entryId,
  version: entryVersions.version,
  title: entryVersions.title,
  body: entryVersions.body,
  source: entryVersions.source,
  authorType: entryVersions.authorType,
  authorId: entryVersions.authorId,
  runId: entryVersions.runId,
  createdAt: entryVersions.createdAt,
}

type VersionSelect = {
  entryId: string
  version: number
  title: string
  body: EntryBody
  source: string | null
  authorType: AuthorType
  authorId: string
  runId: string | null
  createdAt: Date
}

const toRow = (
  entry: { id: string; kind: EntryKind; slug: string },
  v: VersionSelect,
  latestVersion: number,
): EntryVersionRow => ({
  id: entry.id,
  kind: entry.kind,
  slug: entry.slug,
  version: v.version,
  latestVersion,
  title: v.title,
  body: v.body,
  source: v.source,
  author: { type: v.authorType, id: v.authorId },
  runId: v.runId,
  createdAt: v.createdAt,
})

/** The entry's newest version, or the given one. NOT_FOUND for an unknown entry or version. */
export async function getEntry(
  db: Database,
  id: string,
  version?: number,
): Promise<EntryVersionRow> {
  const [entry] = await db.select().from(entries).where(eq(entries.id, id))
  if (!entry) throw new AppError("NOT_FOUND", "Entry not found")
  const latest = await latestVersionNumber(db, id)
  const [row] = await db
    .select(versionColumns)
    .from(entryVersions)
    .where(and(eq(entryVersions.entryId, id), eq(entryVersions.version, version ?? latest)))
  if (!row) throw new AppError("NOT_FOUND", `Entry has no version ${version}`)
  return toRow(entry, row, latest)
}

/** Every version of an entry, oldest first, each with its author. */
export async function getEntryHistory(db: Database, id: string): Promise<EntryVersionRow[]> {
  const [entry] = await db.select().from(entries).where(eq(entries.id, id))
  if (!entry) throw new AppError("NOT_FOUND", "Entry not found")
  const rows = await db
    .select(versionColumns)
    .from(entryVersions)
    .where(eq(entryVersions.entryId, id))
    .orderBy(asc(entryVersions.version))
  const latest = rows.at(-1)?.version ?? 0
  return rows.map((row) => toRow(entry, row, latest))
}

/** Each entry joined to its newest version. */
function latestVersions(db: Database) {
  const newest = db
    .select({ entryId: entryVersions.entryId, version: max(entryVersions.version).as("newest") })
    .from(entryVersions)
    .groupBy(entryVersions.entryId)
    .as("newest")
  return db
    .select({
      id: entries.id,
      kind: entries.kind,
      slug: entries.slug,
      entryCreatedAt: entries.createdAt,
      version: entryVersions.version,
      title: entryVersions.title,
      body: entryVersions.body,
      updatedAt: entryVersions.createdAt,
    })
    .from(entries)
    .innerJoin(newest, eq(newest.entryId, entries.id))
    .innerJoin(
      entryVersions,
      and(eq(entryVersions.entryId, entries.id), eq(entryVersions.version, newest.version)),
    )
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Entries by kind then slug, one page after `after`. `query` matches a title or slug. */
export async function listEntries(
  db: Database,
  opts: {
    kind?: EntryKind
    query?: string
    after?: { kind: EntryKind; slug: string }
    limit: number
  },
): Promise<EntrySummary[]> {
  const { after } = opts
  const rows = await latestVersions(db)
    .where(
      and(
        opts.kind ? eq(entries.kind, opts.kind) : undefined,
        opts.query
          ? or(
              ilike(entryVersions.title, `%${escapeLike(opts.query)}%`),
              ilike(entries.slug, `%${escapeLike(opts.query)}%`),
            )
          : undefined,
        after
          ? or(
              gt(entries.kind, after.kind),
              and(eq(entries.kind, after.kind), gt(entries.slug, after.slug)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(entries.kind), asc(entries.slug))
    .limit(opts.limit)
  return rows.map(({ body: _body, entryCreatedAt, ...row }) => ({
    ...row,
    createdAt: entryCreatedAt,
  }))
}

/** Full-text search over the newest version of each entry (title, slug and the body's text). */
export async function searchEntries(
  db: Database,
  opts: { query: string; kinds?: readonly EntryKind[]; limit: number },
): Promise<SearchHit[]> {
  const document = sql`to_tsvector('english', ${entries.slug} || ' ' || ${entryVersions.title} || ' ' || coalesce(${entryVersions.body}->>'text', ''))`
  const query = sql`websearch_to_tsquery('english', ${opts.query})`
  const rows = await latestVersions(db)
    .where(
      and(
        sql`${document} @@ ${query}`,
        opts.kinds && opts.kinds.length > 0 ? inArray(entries.kind, [...opts.kinds]) : undefined,
      ),
    )
    .orderBy(desc(sql`ts_rank(${document}, ${query})`), asc(entries.kind), asc(entries.slug))
    .limit(opts.limit)
  return rows.map(({ body, entryCreatedAt, ...row }) => ({
    ...row,
    createdAt: entryCreatedAt,
    excerpt: body.text.slice(0, 240),
  }))
}

/**
 * A person's edit: version n+1, kept beside n. `baseVersion` is the version the editor read; if the
 * entry has moved on, CONFLICT and nothing is written.
 */
export function editEntry(
  db: Database,
  input: {
    id: string
    title: string
    body: EntryBody
    baseVersion: number
    author: Author
    now: Date
  },
): Promise<EntryVersionRow> {
  return db.transaction(async (tx) => {
    const entry = await lockEntry(tx, input.id)
    if (!entry) throw new AppError("NOT_FOUND", "Entry not found")
    const latest = await latestVersionNumber(tx, entry.id)
    if (latest !== input.baseVersion) {
      throw new AppError(
        "CONFLICT",
        `The entry is at version ${latest}, not ${input.baseVersion}: nothing was saved`,
        { hint: "Read the entry again with get_entry, merge your change into it and retry." },
      )
    }
    await appendVersion(tx, {
      entryId: entry.id,
      version: latest + 1,
      title: input.title,
      body: input.body,
      source: null,
      author: input.author,
      runId: null,
      now: input.now,
    })
    return getEntry(tx, entry.id, latest + 1)
  })
}
