// Account lifecycle rules that better-auth doesn't know about, as one plugin:
//  - deletion: refused while the user owns an organization they can't take with them (any org other
//    than their personal one, or one with other members), or the personal one has a live subscription.
//    Checked when the confirmation is requested and again when the link is opened (beforeDelete).
//  - unlinking: the last way in is kept. A way in is a password, another linked account, or a passkey
//    (better-auth only counts accounts). `allowUnlinkingAll` is on so the check here is the only one.
//  - email change: the address being replaced is told a change was requested (the new address gets
//    the confirmation link from index.ts), and the person is told in the app once it went through.
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api"
import { decodeJwt, jwtVerify } from "jose"
import {
  ACTIVE_SUBSCRIPTION_CODE,
  LAST_SIGN_IN_METHOD_CODE,
  OWNS_ORGANIZATION_CODE,
} from "./constants"
import { type Adapter, findMember, type Member, personalSlug } from "./membership"
import type { Notices } from "./notices"

/** Subscription states that still bill. */
const BILLING_STATUSES = ["active", "trialing", "past_due"]

interface Org {
  id: string
  name: string
  slug: string | null
}

/** An owner by its stored role list, read as better-auth reads it: split on commas, each trimmed. */
const isOwner = (role: string) =>
  role
    .split(",")
    .map((r) => r.trim())
    .includes("owner")

/**
 * The organizations a user can't leave behind by deleting their account: owned by them, and either
 * not their personal one or shared with other members.
 */
export async function blockingOrganizations(db: Adapter, userId: string): Promise<Org[]> {
  const memberships = await db.findMany<Member>({
    model: "member",
    where: [{ field: "userId", value: userId }],
  })
  const blockers: Org[] = []
  for (const member of memberships) {
    if (!isOwner(member.role)) continue
    const org = await db.findOne<Org>({
      model: "organization",
      where: [{ field: "id", value: member.organizationId }],
    })
    if (!org) continue
    const others = await db.count({
      model: "member",
      where: [
        { field: "organizationId", value: org.id },
        { field: "userId", value: userId, operator: "ne" },
      ],
    })
    if (org.slug !== personalSlug(userId) || others > 0) blockers.push(org)
  }
  return blockers
}

/**
 * The user's personal organization: the one with their personal slug, which they own. The slug alone
 * isn't enough to delete an organization by, so membership is checked too.
 */
async function personalOrganizationOf(db: Adapter, userId: string): Promise<Org | null> {
  const org = await db.findOne<Org>({
    model: "organization",
    where: [{ field: "slug", value: personalSlug(userId) }],
  })
  if (!org) return null
  const member = await findMember(db, userId, org.id)
  return member && isOwner(member.role) ? org : null
}

/** Throws the refusal the app shows, or returns when the account may be deleted. */
export async function assertCanDelete(
  db: Adapter,
  userId: string,
  billing: boolean,
): Promise<void> {
  const [blocker] = await blockingOrganizations(db, userId)
  if (blocker) {
    throw APIError.from("BAD_REQUEST", {
      message: `You own ${blocker.name}. Transfer or delete it first.`,
      code: OWNS_ORGANIZATION_CODE,
    })
  }
  const org = await personalOrganizationOf(db, userId)
  // Subscriptions exist only when the stripe plugin is mounted; its model is absent otherwise.
  if (!org || !billing) return
  const subs = await db.findMany<{ status: string }>({
    model: "subscription",
    where: [{ field: "referenceId", value: org.id }],
  })
  if (subs.some((s) => BILLING_STATUSES.includes(s.status))) {
    throw APIError.from("BAD_REQUEST", {
      message: "Cancel your subscription before deleting your account.",
      code: ACTIVE_SUBSCRIPTION_CODE,
    })
  }
}

/**
 * Removes the user's personal organization with them. Its members, invitations and app data
 * (projects, agents, runs, audit) go by cascade; API keys and SSO providers are keyed by organization
 * id with no foreign key, so they are removed here. Runs after assertCanDelete. The organization is
 * deleted raw (no organization hooks run), so `onRemove` runs the cleanup plugins would have done
 * on /organization/delete (entitlements' rows), before the row goes. Returns the deleted
 * organization's id (null when there was none), so its files can be swept once the user is gone.
 */
export async function removePersonalOrganization(
  db: Adapter,
  userId: string,
  billing: boolean,
  onRemove?: (organizationId: string) => Promise<void>,
): Promise<string | null> {
  const org = await personalOrganizationOf(db, userId)
  if (!org) return null
  await onRemove?.(org.id)
  await db.deleteMany({ model: "apikey", where: [{ field: "referenceId", value: org.id }] })
  await db.deleteMany({ model: "ssoProvider", where: [{ field: "organizationId", value: org.id }] })
  if (billing) {
    await db.deleteMany({ model: "subscription", where: [{ field: "referenceId", value: org.id }] })
  }
  await db.deleteMany({ model: "organization", where: [{ field: "id", value: org.id }] })
  return org.id
}

/** The address a change-of-email token replaces, when the token is one (else null). */
export function changeRequestOf(token: string): { oldEmail: string } | null {
  try {
    const payload = decodeJwt(token)
    if (payload.requestType !== "change-email-verification") return null
    if (typeof payload.updateTo !== "string" || typeof payload.email !== "string") return null
    return { oldEmail: payload.email }
  } catch {
    return null
  }
}

/**
 * Whether /verify-email succeeded. After hooks run for refusals too, so this reads the endpoint's
 * answer: its JSON (no callbackURL), or the 302 to exactly the callbackURL it was given. A refusal is
 * an APIError, or a 302 to the callbackURL with `error=` appended, so it never matches. The redirect
 * is better-call's APIError, not better-auth's subclass, hence `isAPIError` over `instanceof`.
 */
function verifyEmailSucceeded(ctx: { query?: unknown; context: { returned?: unknown } }): boolean {
  const returned = ctx.context.returned
  if (returned === undefined || returned === null) return false
  if (!isAPIError(returned)) return true
  if (returned.statusCode !== 302) return false
  const callbackURL = (ctx.query as { callbackURL?: unknown } | undefined)?.callbackURL
  const headers = returned.headers as Headers | Record<string, string> | undefined
  const location = headers instanceof Headers ? headers.get("location") : headers?.location
  return typeof callbackURL === "string" && location === callbackURL
}

/**
 * The change a /verify-email request made, if it made one. All of these must hold:
 * - the endpoint succeeded (see verifyEmailSucceeded)
 * - the token has the server's signature and is a change-of-email verification with different old
 *   and new addresses
 * - the token's user now has the new address
 *
 * A refused request (a used or expired link, another account's session, a forged token) fails the
 * first or second check, whatever the stored address is.
 */
async function completedChange(ctx: {
  query?: unknown
  context: {
    returned?: unknown
    secret: string
    internalAdapter: { findUserById: (id: string) => Promise<{ id: string; email: string } | null> }
  }
}): Promise<{ userId: string } | null> {
  if (!verifyEmailSucceeded(ctx)) return null
  const token = (ctx.query as { token?: unknown } | undefined)?.token
  if (typeof token !== "string") return null
  let payload: Record<string, unknown>
  try {
    payload = (
      await jwtVerify(token, new TextEncoder().encode(ctx.context.secret), {
        algorithms: ["HS256"],
      })
    ).payload
  } catch {
    return null
  }
  const { requestType, email, updateTo, userId } = payload
  if (requestType !== "change-email-verification") return null
  if (typeof email !== "string" || typeof updateTo !== "string" || typeof userId !== "string") {
    return null
  }
  if (email.toLowerCase() === updateTo.toLowerCase()) return null
  const user = await ctx.context.internalAdapter.findUserById(userId)
  return user?.email.toLowerCase() === updateTo.toLowerCase() ? { userId } : null
}

export function accountPlugin(opts: {
  notices: Notices
  adapter: () => Promise<Adapter>
  /** Whether the stripe plugin is mounted (its subscription model exists only then). */
  billing: boolean
  /** A change of sign-in email went through (once per change, verified account or not). */
  onEmailChanged: (userId: string) => Promise<void>
}) {
  return {
    id: "proof-account",
    hooks: {
      before: [
        {
          // better-auth's change-email branch of /verify-email creates a session for whoever opens the
          // link. Here it needs the user's own session, so the link alone can't sign anyone in.
          matcher: (ctx: { path?: string }) => ctx.path === "/verify-email",
          handler: createAuthMiddleware(async (ctx) => {
            // The query isn't parsed yet in a before hook, so read every `token` the request carries.
            const tokens = [
              ...(typeof (ctx.query as { token?: unknown } | undefined)?.token === "string"
                ? [(ctx.query as { token: string }).token]
                : []),
              ...(ctx.request ? new URL(ctx.request.url).searchParams.getAll("token") : []),
            ]
            const change = tokens.map((t) => changeRequestOf(t)).find((c) => c !== null)
            if (!change) return
            const session = await getSessionFromCtx(ctx)
            if (session && session.user.email.toLowerCase() === change.oldEmail.toLowerCase())
              return
            // Refused before anything changes; the token stays unused until the right person opens it.
            // The link as it was opened (its callbackURL included), so the sign-in resumes it unchanged.
            const link = ctx.request
              ? `${new URL(ctx.request.url).pathname}${new URL(ctx.request.url).search}`
              : `/api/auth/verify-email?token=${encodeURIComponent(tokens.find((t) => changeRequestOf(t) !== null) ?? "")}`
            throw ctx.redirect(
              `/sign-in?error=SIGN_IN_TO_CONFIRM_EMAIL_CHANGE&next=${encodeURIComponent(link)}`,
            )
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/delete-user",
          handler: createAuthMiddleware(async (ctx) => {
            // Refused before the confirmation email goes out, not only when its link is opened.
            const session = await getSessionFromCtx(ctx)
            if (session) {
              await assertCanDelete(await opts.adapter(), session.user.id, opts.billing)
            }
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/unlink-account",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx)
            const accountId = (ctx.body as { accountId?: unknown } | undefined)?.accountId
            if (!session || typeof accountId !== "string") return
            const db = await opts.adapter()
            const accounts = await db.findMany<{ id: string }>({
              model: "account",
              where: [{ field: "userId", value: session.user.id }],
            })
            // Not theirs (or unknown): better-auth answers ACCOUNT_NOT_FOUND.
            if (!accounts.some((a) => a.id === accountId)) return
            const remaining = accounts.filter((a) => a.id !== accountId).length
            const passkeys = await db.count({
              model: "passkey",
              where: [{ field: "userId", value: session.user.id }],
            })
            if (remaining === 0 && passkeys === 0) {
              throw APIError.from("BAD_REQUEST", {
                message:
                  "This is your only way to sign in. Add a password or a passkey before disconnecting it.",
                code: LAST_SIGN_IN_METHOD_CODE,
              })
            }
          }),
        },
      ],
      after: [
        {
          // Not better-auth's afterEmailVerification: since 1.7.16 that runs only for an account that
          // was verified already, and the notice is for every account whose address changed.
          matcher: (ctx: { path?: string }) => ctx.path === "/verify-email",
          handler: createAuthMiddleware(async (ctx) => {
            const change = await completedChange(ctx)
            if (change) await opts.onEmailChanged(change.userId)
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/change-email",
          handler: createAuthMiddleware(async (ctx) => {
            // After hooks also run for a refused request (same address, stale session): no notice then.
            if (ctx.context.returned instanceof APIError) return
            const session = await getSessionFromCtx(ctx)
            const newEmail = (ctx.body as { newEmail?: unknown } | undefined)?.newEmail
            if (!session || typeof newEmail !== "string") return
            await opts.notices.emailChangeRequested({
              to: session.user.email,
              newEmail: newEmail.toLowerCase(),
              name: session.user.name,
            })
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
