// Making a founder's account, on the server. A deployed hq has no public sign-up, so the only way
// an account for a founder's address comes to exist is this: it creates the user in hq's database
// with a verified address and a generated password, links the `founders` row, and gives back the id
// to list in HQ_FOUNDERS (`id:<user id>=<slack user id>`). That id, not the address, is what makes
// the account a founder in a deployed hq (data/founders.ts, `pinnedOnly`), so an account someone
// else registered with the founder's address, even one the founder later verified from an emailed
// link, is never one.
//
// The password goes only where `deliverPassword` puts it (the CLI writes a 0600 file the operator
// named). It is never returned, logged or printed.
import { randomBytes } from "node:crypto"

import { type Auth, removeUnusedAccount } from "@proof/auth"
import { type Database, session, user } from "@proof/db"
import { eq } from "drizzle-orm"

import { addFounder, founderForSlackUser, SLACK_USER_ID } from "./data/founders"
import { assertSignUpClosedWhenDeployed } from "./deploy-mode"

/** A refusal the operator can act on: the message says what to do. */
export class CreateFounderRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CreateFounderRefused"
  }
}

export interface CreateFounderDeps {
  db: Database
  /**
   * An auth made for this call with sign-up allowed (`createHqAuth(db, { ...config, allowSignUp:
   * true })`), used in-process to hash the password and make the user's personal organization.
   * It is never served, so no HTTP request can reach its open sign-up.
   */
  auth: Auth
  now: () => Date
  /** The environment as hq boots with it: NODE_ENV, and HQ_ALLOW_SIGNUP as set (not `auth`'s). */
  env: { nodeEnv: string | undefined; allowSignUp: boolean }
  /**
   * Where the generated password goes: called once, before the account exists, so a channel that
   * fails creates nothing. Whatever it writes to must not be a log or the terminal.
   */
  deliverPassword: (password: string) => Promise<void>
}

export interface CreatedFounder {
  userId: string
  /** The HQ_FOUNDERS entry that pins this account as the founder. */
  entry: string
}

/** Refuses (CreateFounderRefused) rather than touching an account that already has the address. */
export async function createFounder(
  deps: CreateFounderDeps,
  input: { email: string; slackUserId: string },
): Promise<CreatedFounder> {
  const { db, auth } = deps
  try {
    assertSignUpClosedWhenDeployed(deps.env)
  } catch (error) {
    throw new CreateFounderRefused(error instanceof Error ? error.message : String(error))
  }
  const email = input.email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new CreateFounderRefused("That is not an email address.")
  }
  if (!SLACK_USER_ID.test(input.slackUserId)) {
    throw new CreateFounderRefused("--slack-id must be a Slack user id such as U01ABC23DEF.")
  }

  const [existing] = await db
    .select({ id: user.id, verified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email))
  if (existing) {
    // Never reuse it: whoever registered the address holds its password. If this account is
    // genuinely the founder's, the operator pins it by hand after resetting its credentials.
    throw new CreateFounderRefused(
      existing.verified
        ? "An account with this address already exists. It may have been registered by someone " +
            "else and verified from the founder's inbox, so create-founder will not adopt it. " +
            "Delete it first, or, if it is certainly the founder's, pin it with id:" +
            `${existing.id}=<slack id> in HQ_FOUNDERS after resetting its password.`
        : "An UNVERIFIED account with this address already exists: someone registered the " +
            "address before its owner (a squatter), and holds that account's password. " +
            "create-founder refuses it. Delete that account from hq's database, then run this again.",
    )
  }
  if (await founderForSlackUser(db, input.slackUserId)) {
    throw new CreateFounderRefused("That Slack user is already another founder.")
  }

  const password = randomBytes(24).toString("base64url")
  await deps.deliverPassword(password)

  const created = await auth.api.signUpEmail({ body: { email, password, name: email } })
  const userId = created.user.id
  try {
    await db.transaction(async (tx) => {
      // Made on the server by the operator: the address counts as verified, and the sign-up's
      // session (it signs the new user in) is not a login anyone holds. Exactly one row must be
      // the account: sign-up can answer with an id that names none (a duplicate it hid), and a
      // founder row for no account must never be written.
      const verified = await tx
        .update(user)
        .set({ emailVerified: true })
        .where(eq(user.id, userId))
        .returning({ id: user.id })
      if (verified.length !== 1) throw new Error("the new account was not found to verify")
      await tx.delete(session).where(eq(session.userId, userId))
      // The second writer of the founders table (beside syncFounders): run against a deployed hq it
      // adds a row HQ_FOUNDERS does not list yet, so new instances refuse until the entry is in
      // HQ_FOUNDERS, `pnpm hq:predeploy` has run and hq is redeployed (data/founders.ts).
      await addFounder(tx, { userId, slackUserId: input.slackUserId, now: deps.now() })
    })
  } catch (error) {
    // The first line only: a database error goes on to quote the statement's parameters.
    const why = (error instanceof Error ? error.message : String(error)).split("\n")[0]
    // Undo the account, so a re-run starts clean instead of finding an unverified account with an
    // address it cannot tell from a squatter's (the password was never given to anyone).
    try {
      // The account and its empty personal organization (the pieces sign-up made).
      await removeUnusedAccount(auth, userId)
    } catch (cleanup) {
      const first = (cleanup instanceof Error ? cleanup.message : String(cleanup)).split("\n")[0]
      throw new Error(
        `The account ${userId} was created but could not be linked as a founder (${why}), and it ` +
          `could not be removed (${first}). Delete it from hq's database, then run again.`,
      )
    }
    throw new Error(
      `The founder could not be linked (${why}); the new account was removed. Run again.`,
    )
  }
  return { userId, entry: `id:${userId}=${input.slackUserId}` }
}
