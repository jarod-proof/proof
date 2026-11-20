import { type Caller, operationsFor } from "@proof/api"
import type { Catalog } from "@proof/auth"
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { z } from "zod"

import { type Author } from "../data/entries"
import { isFounder } from "../data/founders"
import { ENTRY_KINDS } from "../db/schema"

export const defineOperation = operationsFor<Catalog>()

/** What the operations draw on. */
export interface HqDeps {
  db: Database
  /** The clock: timestamps read it, so tests can move time. */
  now: () => Date
}

export const entryKind = z.enum(ENTRY_KINDS)

/** A slug names an entry within its kind: lower-case words joined by hyphens. */
export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lower-case letters, digits and hyphens")
  .max(80)

export const entryBody = z
  .object({ text: z.string().trim().min(1).max(100_000).describe("The entry's prose") })
  .catchall(z.unknown())
  .describe("The content: prose in `text`, plus any structured fields the kind needs")

export const title = z.string().trim().min(1).max(200)

export const isoDate = z.string().describe("ISO 8601 time")

/** Who is calling, as an entry version or a proposal records them: a person, or an agent. */
export function authorOf(caller: Caller): Author {
  const id = caller.actor.type === "user" ? caller.actor.userId : caller.actor.keyId
  return { type: caller.via === "session" ? "person" : "agent", id }
}

/**
 * The trust rule's gate: only a signed-in person (never a key or an OAuth token) who is also a
 * founder (a row of hq.founders, see data/founders.ts) decides a proposal or edits an entry. hq's
 * sign-up is open, so being a signed-in person is not enough. Returns the founder's user id.
 */
export async function requireFounder(deps: HqDeps, caller: Caller): Promise<string> {
  if (caller.via !== "session" || caller.actor.type !== "user") {
    throw new AppError("FORBIDDEN", "Only a signed-in founder can do this", {
      hint: "Ask a founder to approve it in the admin UI or Slack. API keys and AI clients can't.",
    })
  }
  if (!(await isFounder(deps.db, caller.actor.userId))) {
    throw new AppError("FORBIDDEN", "Only a founder can do this", {
      hint: "Your account is not on this org's founder list.",
    })
  }
  return caller.actor.userId
}
