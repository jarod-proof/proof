// End-to-end auth flows over HTTP, driven the way a web app drives them: the real `createClient`,
// a cookie jar and an Origin header, through the app's router into better-auth. These are the
// flows that must keep working across better-auth upgrades, including minor and patch releases,
// so they assert status codes, error codes, cookies, redirects and emails rather than internals.
import { createHash, createHmac, randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest"
import { and, eq } from "drizzle-orm"
import { SignJWT } from "jose"
import { personalSlug } from "@proof/auth"
import {
  auditEvent,
  member,
  notification,
  organization,
  passkey as passkeyTable,
  session as sessionTable,
  user as userTable,
  verification,
} from "@proof/db/schema"
import { setErrorReporter } from "@proof/errors"
import { createLogger } from "@proof/logger"
import { createMemoryStore } from "@proof/storage"
import { BASE, createTestApp, SECRET } from "./app.test.helpers"
import { browser } from "./browser.test.helpers"

const PASSWORD = "correct-horse-battery"
/** RFC 4648 base32, as authenticator secrets are written. */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const c of input.replace(/=+$/, "").toUpperCase()) {
    value = ((value << 5) | alphabet.indexOf(c)) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** The 6-digit TOTP (RFC 6238, 30 seconds, SHA-1) an authenticator app shows for a secret. */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const hash = createHmac("sha1", base32Decode(secret)).update(counter).digest()
  const offset = (hash[hash.length - 1] ?? 0) & 0xf
  const code =
    (((hash[offset] ?? 0) & 0x7f) << 24) |
    ((hash[offset + 1] ?? 0) << 16) |
    ((hash[offset + 2] ?? 0) << 8) |
    (hash[offset + 3] ?? 0)
  return String(code % 1_000_000).padStart(6, "0")
}

const REDIRECT = "http://127.0.0.1:33418/callback"
const MCP = `${BASE}/mcp`

/** What the product API answers for a session that no longer works. */
const SIGNED_OUT = { status: 401, body: { error: { code: "UNAUTHORIZED" } } }

describe("auth flows over HTTP (real client, real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  /** Every access-log line the app writes. */
  const logLines: string[] = []
  /**
   * The file store, with deletePrefix wrapped: every sweep records whether the deleted user's or
   * organization's row was still there when it ran (it must never be), and `failSweeps` makes the
   * store throw after recording.
   */
  const files = createMemoryStore({ driver: "memory", publicUrl: `${BASE}/files` })
  const sweeps: { prefix: string; rowLeft: boolean }[] = []
  let failSweeps = false
  const sweepPrefix = files.deletePrefix.bind(files)
  files.deletePrefix = async (prefix) => {
    const [kind, id = ""] = prefix.split("/")
    const model = kind === "org" ? "organization" : "user"
    const row = await (await t.auth.$context).adapter.findOne({
      model,
      where: [{ field: "id", value: id }],
    })
    sweeps.push({ prefix, rowLeft: row !== null })
    if (failSweeps) throw new Error("AccessDenied: s3:ListBucket")
    return sweepPrefix(prefix)
  }
  beforeAll(async () => {
    const logger = createLogger({ level: "info", destination: { write: (s) => logLines.push(s) } })
    t = await createTestApp([], { logger, files })
  })
  afterAll(async () => {
    // Every deletion in this file, not only the sweep tests', swept after its row was gone.
    expect(sweeps.filter((s) => s.rowLeft)).toEqual([])
    await t.close()
  })

  const open = () => browser((url, init) => t.app.request(url, init))
  let n = 0
  const email = () => `flow${++n}@example.com`

  /** Sign up in a fresh browser. */
  async function signedUp(name = "Ada") {
    const b = open()
    const address = email()
    const { data, error } = await b.client.signUp.email({
      email: address,
      password: PASSWORD,
      name,
    })
    if (error || !data) throw new Error(`sign-up failed: ${JSON.stringify(error)}`)
    return { b, email: address, userId: data.user.id }
  }

  const whoami = async (b: ReturnType<typeof open>) => {
    const res = await b.request("/v1/whoami")
    return {
      status: res.status,
      body: (await res.json()) as { organizationId?: string; error?: { code: string } },
    }
  }

  /** Emails to an address, once at least `count` have arrived (senders may run in the background). */
  const delivered = (to: string, count = 1) =>
    vi.waitFor(() => {
      const mails = inbox(to)
      if (mails.length < count) throw new Error(`waiting for ${count} email(s) to ${to}`)
      return mails
    })

  const inbox = (to: string) => t.outbox.filter((m) => m.to === to)

  describe("sign-up and sessions", () => {
    it("signs up into a session acting in a new personal organization", async () => {
      const { b, userId } = await signedUp("Grace")
      expect(b.jar.size).toBeGreaterThan(0)

      const { data: session } = await b.client.getSession()
      expect(session?.user.id).toBe(userId)
      const orgId = session?.session.activeOrganizationId
      expect(orgId).toBeTruthy()

      const { data: orgs } = await b.client.organization.list()
      expect(orgs?.map((o) => o.id)).toEqual([orgId])
      expect(orgs?.[0]?.name).toBe("Grace's workspace")
      const { data: member } = await b.client.organization.getActiveMember()
      expect(member?.role).toBe("owner")

      // The cookie works against the product API, not just better-auth.
      expect(await whoami(b)).toMatchObject({ status: 200, body: { organizationId: orgId } })
    })

    it("rejects a second sign-up with the same email", async () => {
      const { email: taken } = await signedUp()
      const { error } = await open().client.signUp.email({
        email: taken,
        password: PASSWORD,
        name: "Again",
      })
      expect(error).toMatchObject({ status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" })
    })

    it("signs in with the right password only", async () => {
      const { email: address } = await signedUp()
      const wrong = await open().client.signIn.email({ email: address, password: "not-it-12345" })
      expect(wrong.error).toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" })

      const b = open()
      const { data, error } = await b.client.signIn.email({ email: address, password: PASSWORD })
      expect(error).toBeNull()
      expect(data?.user.email).toBe(address)
      expect((await whoami(b)).status).toBe(200)
    })

    it("signs out: the session stops working", async () => {
      const { b } = await signedUp()
      const before = b.cookie()
      expect((await b.client.signOut()).error).toBeNull()
      expect((await b.client.getSession()).data).toBeNull()
      expect(await whoami(b)).toMatchObject(SIGNED_OUT)

      // Replaying the old cookie doesn't bring it back.
      const replay = await t.req("/v1/whoami", { headers: { cookie: before } })
      expect(replay.status).toBe(401)
    })

    it("lists a user's sessions and revokes the others", async () => {
      const { b: laptop, email: address } = await signedUp()
      const phone = open()
      await phone.client.signIn.email({ email: address, password: PASSWORD })

      const { data: sessions } = await laptop.client.listSessions()
      expect(sessions).toHaveLength(2)

      expect((await laptop.client.revokeOtherSessions()).error).toBeNull()
      expect(await whoami(phone)).toMatchObject(SIGNED_OUT)
      expect((await whoami(laptop)).status).toBe(200)
    })
  })

  describe("CSRF", () => {
    it("rejects cookie requests from an untrusted origin or with no origin", async () => {
      const { b } = await signedUp()
      const body = JSON.stringify({ name: "Evil", slug: `evil-${n}` })
      const post = (headers: Record<string, string>) =>
        b.request("/api/auth/organization/create", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        })

      const evil = await post({ origin: "https://evil.example" })
      expect(evil.status).toBe(403)
      expect(await evil.json()).toMatchObject({ code: "INVALID_ORIGIN" })

      // `browser` adds Origin unless one is set; "null" is what a sandboxed page sends.
      const nullOrigin = await post({ origin: "null" })
      expect(nullOrigin.status).toBe(403)
      expect(await nullOrigin.json()).toMatchObject({ code: "MISSING_OR_NULL_ORIGIN" })

      const { data: orgs } = await b.client.organization.list()
      expect(orgs).toHaveLength(1)
    })

    it("refuses a password-reset link that would redirect off-site", async () => {
      const { email: address } = await signedUp()
      const { error } = await open().client.requestPasswordReset({
        email: address,
        redirectTo: "https://evil.example/steal",
      })
      expect(error).toMatchObject({ status: 403, code: "INVALID_REDIRECT_URL" })
      expect(inbox(address)).toHaveLength(0)
    })
  })

  describe("password reset by email", () => {
    it("keeps the reset token out of the access log", async () => {
      const { email: address } = await signedUp()
      const visitor = open()
      await visitor.client.requestPasswordReset({ email: address, redirectTo: `${BASE}/reset` })
      const [mail] = await delivered(address)
      const token = new URL(mail?.link ?? "").pathname.split("/").at(-1) ?? ""
      expect(token.length).toBeGreaterThan(8)

      const before = logLines.length
      await visitor.request(mail?.link ?? "")
      const visit = logLines.slice(before).join("")
      expect(visit).not.toContain(token)
      expect(visit).toContain("/api/auth/reset-password/[Redacted]")
    })

    it("emails a link that leads to a working new password", async () => {
      const { b: old, email: address } = await signedUp()
      const visitor = open()
      const { error } = await visitor.client.requestPasswordReset({
        email: address,
        redirectTo: `${BASE}/reset-password`,
      })
      expect(error).toBeNull()

      const [mail] = await delivered(address)
      expect(mail?.link).toMatch(/^http:\/\/localhost:3000\/api\/auth\/reset-password\//)

      // The emailed link redirects to the app's page with the token in the query.
      const landing = await visitor.request(mail?.link ?? "")
      expect(landing.status).toBe(302)
      const page = new URL(landing.headers.get("location") ?? "")
      expect(`${page.origin}${page.pathname}`).toBe(`${BASE}/reset-password`)
      const token = page.searchParams.get("token") ?? ""
      expect(token).toBeTruthy()

      const reset = await visitor.client.resetPassword({ newPassword: "a-new-passphrase", token })
      expect(reset.error).toBeNull()

      const stale = await open().client.signIn.email({ email: address, password: PASSWORD })
      expect(stale.error?.code).toBe("INVALID_EMAIL_OR_PASSWORD")
      const fresh = await open().client.signIn.email({
        email: address,
        password: "a-new-passphrase",
      })
      expect(fresh.error).toBeNull()

      // A token works once.
      const again = await visitor.client.resetPassword({ newPassword: "yet-another-one", token })
      expect(again.error).toMatchObject({ status: 400, code: "INVALID_TOKEN" })

      // The password-changed notice is the notification's email (NOTIFICATION_EMAIL_ROUTES), sent
      // by the delivery sweep, which the server runs on a timer.
      await t.auth.api.processDeliveries({})
      const notices = await delivered(address, 2)
      expect(notices).toHaveLength(2)
      expect(notices[1]?.subject).toMatch(/password/i)
      // A reset signs out every existing session (revokeSessionsOnPasswordReset).
      expect(await whoami(old)).toMatchObject(SIGNED_OUT)
    })

    it("answers the same for an unknown email and sends nothing", async () => {
      const before = t.outbox.length
      const { error } = await open().client.requestPasswordReset({
        email: "nobody@example.com",
        redirectTo: `${BASE}/reset-password`,
      })
      expect(error).toBeNull()
      expect(t.outbox.length).toBe(before)
    })

    it("sends a bad or missing token back to the app with an error", async () => {
      const landing = await open().request(
        `/api/auth/reset-password/not-a-token?callbackURL=${encodeURIComponent(`${BASE}/reset`)}`,
      )
      expect(landing.status).toBe(302)
      expect(landing.headers.get("location")).toBe(`${BASE}/reset?error=INVALID_TOKEN`)

      const { error } = await open().client.resetPassword({
        newPassword: "whatever-1234",
        token: "not-a-token",
      })
      expect(error).toMatchObject({ status: 400, code: "INVALID_TOKEN" })
    })
  })

  describe("email verification", () => {
    it("emails a link that marks the address verified", async () => {
      const { b, email: address } = await signedUp()
      expect((await b.client.getSession()).data?.user.emailVerified).toBe(false)

      const { error } = await b.client.sendVerificationEmail({
        email: address,
        callbackURL: "/welcome",
      })
      expect(error).toBeNull()
      const [mail] = await delivered(address)
      expect(mail?.link).toMatch(/^http:\/\/localhost:3000\/api\/auth\/verify-email\?token=/)

      const landing = await b.request(mail?.link ?? "")
      expect(landing.status).toBe(302)
      expect(landing.headers.get("location")).toBe("/welcome")
      expect(
        (await b.client.getSession({ query: { disableCookieCache: true } })).data?.user
          .emailVerified,
      ).toBe(true)
    })

    it("rejects a forged token", async () => {
      const res = await open().request("/api/auth/verify-email?token=forged")
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ code: "INVALID_TOKEN" })
    })
  })

  describe("change password", () => {
    it("needs the current password, and can sign out every other session", async () => {
      const { b: laptop, email: address } = await signedUp()
      const phone = open()
      await phone.client.signIn.email({ email: address, password: PASSWORD })

      const wrong = await laptop.client.changePassword({
        currentPassword: "not-it-12345",
        newPassword: "a-new-passphrase",
      })
      expect(wrong.error).toMatchObject({ status: 400, code: "INVALID_PASSWORD" })

      const ok = await laptop.client.changePassword({
        currentPassword: PASSWORD,
        newPassword: "a-new-passphrase",
        revokeOtherSessions: true,
      })
      expect(ok.error).toBeNull()
      expect(await whoami(phone)).toMatchObject(SIGNED_OUT)
      expect((await whoami(laptop)).status).toBe(200)
      const fresh = await open().client.signIn.email({
        email: address,
        password: "a-new-passphrase",
      })
      expect(fresh.error).toBeNull()
    })

    it("emails the change, even once the notification is read in the app", async () => {
      const { b, email: address, userId } = await signedUp()
      const before = inbox(address).length

      // An unverified address gets no notification email: the signup may have used someone else's.
      const unverified = await b.client.changePassword({
        currentPassword: PASSWORD,
        newPassword: "an-interim-passphrase",
      })
      expect(unverified.error).toBeNull()
      await t.auth.api.processDeliveries({})
      expect(inbox(address)).toHaveLength(before)

      await t.db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, userId))
      const ok = await b.client.changePassword({
        currentPassword: "an-interim-passphrase",
        newPassword: "a-new-passphrase",
      })
      expect(ok.error).toBeNull()

      const { data } = await b.client.inbox.list({ query: {} })
      const notice = data?.notifications.find((n) => n.type === "account.password_changed")
      expect(notice).toBeTruthy()
      await b.client.inbox.markRead({ id: notice?.id ?? "" })

      // a security notice goes out even if read first (cancelIfRead: false)
      await t.auth.api.processDeliveries({})
      const mails = await delivered(address, before + 1)
      expect(mails.at(-1)?.subject).toMatch(/password/i)
    })
  })

  describe("organizations", () => {
    it("creates a team, invites by email, and the invitee accepts after signing up", async () => {
      const { b: owner } = await signedUp("Owner")
      const { data: org, error } = await owner.client.organization.create({
        name: "Acme",
        slug: `acme-${n}`,
      })
      expect(error).toBeNull()
      if (!org) throw new Error("no organization")
      await owner.client.organization.setActive({ organizationId: org.id })
      expect((await whoami(owner)).body.organizationId).toBe(org.id)

      const inviteeEmail = email()
      const invite = await owner.client.organization.inviteMember({
        email: inviteeEmail,
        role: "member",
        organizationId: org.id,
      })
      expect(invite.error).toBeNull()

      // The invitation email links to the app's accept page with the invitation id.
      const [mail] = await delivered(inviteeEmail)
      expect(mail?.subject).toContain("Acme")
      const link = new URL(mail?.link ?? "")
      expect(link.pathname).toMatch(/^\/accept-invitation\/[^/]+$/)
      const invitationId = link.pathname.split("/").pop() ?? ""

      const invitee = open()
      await invitee.client.signUp.email({ email: inviteeEmail, password: PASSWORD, name: "New" })
      // Browsing your invitations needs a verified address; accepting from the emailed link doesn't.
      const unverified = await invitee.client.organization.listUserInvitations()
      expect(unverified.error).toMatchObject({
        status: 403,
        code: "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION",
      })

      // Someone who has the link but isn't the invited address can't use it.
      const { b: stranger } = await signedUp("Stranger")
      const stolen = await stranger.client.organization.acceptInvitation({ invitationId })
      expect(stolen.error).toMatchObject({
        status: 403,
        code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
      })

      const accepted = await invitee.client.organization.acceptInvitation({ invitationId })
      expect(accepted.error).toBeNull()
      // Accepting makes the new organization the active one.
      expect(await whoami(invitee)).toMatchObject({ status: 200, body: { organizationId: org.id } })

      const { data: full } = await owner.client.organization.getFullOrganization()
      expect(full?.members.map((m) => m.role).sort()).toEqual(["member", "owner"])
    })

    it("changes a member's role, then removes them, cutting off their access", async () => {
      const { b: owner } = await signedUp("Owner")
      const { b: other, userId } = await signedUp("Other")
      const { data: org } = await owner.client.organization.create({
        name: "Team",
        slug: `team-${n}`,
      })
      if (!org) throw new Error("no organization")
      await t.auth.api.addMember({ body: { organizationId: org.id, userId, role: "viewer" } })
      await other.client.organization.setActive({ organizationId: org.id })
      expect((await whoami(other)).body.organizationId).toBe(org.id)

      const { data: full } = await owner.client.organization.getFullOrganization({
        query: { organizationId: org.id },
      })
      const memberId = full?.members.find((m) => m.userId === userId)?.id ?? ""

      // A viewer can't promote themselves.
      const self = await other.client.organization.updateMemberRole({
        memberId,
        role: "admin",
        organizationId: org.id,
      })
      expect(self.error?.status).toBe(403)

      const promoted = await owner.client.organization.updateMemberRole({
        memberId,
        role: "admin",
        organizationId: org.id,
      })
      expect(promoted.error).toBeNull()
      const { data: role } = await other.client.organization.getActiveMemberRole()
      expect(role?.role).toBe("admin")

      const removed = await owner.client.organization.removeMember({
        memberIdOrEmail: memberId,
        organizationId: org.id,
      })
      expect(removed.error).toBeNull()
      expect(await whoami(other)).toMatchObject(SIGNED_OUT)
    })

    it("lets a member leave, and an owner delete the organization", async () => {
      const { b: owner } = await signedUp("Owner")
      const { b: other, userId } = await signedUp("Other")
      const { data: org } = await owner.client.organization.create({
        name: "Short-lived",
        slug: `short-${n}`,
      })
      if (!org) throw new Error("no organization")
      await t.auth.api.addMember({ body: { organizationId: org.id, userId, role: "member" } })

      expect((await other.client.organization.leave({ organizationId: org.id })).error).toBeNull()
      const { data: left } = await other.client.organization.list()
      expect(left?.map((o) => o.id)).not.toContain(org.id)

      const deleted = await owner.client.organization.delete({ organizationId: org.id })
      expect(deleted.error).toBeNull()
      const { data: remaining } = await owner.client.organization.list()
      expect(remaining?.map((o) => o.id)).not.toContain(org.id)
    })
  })

  describe("logos and images are set by the upload operations", () => {
    const REFUSED = { status: 400, code: "USE_UPLOAD_OPERATION" }
    const EVIL = "https://evil.example/logo.png"

    it("refuses a client-supplied organization logo on create and update, and clears with null", async () => {
      const { b } = await signedUp("Logo Owner")
      const refusedCreate = await b.client.organization.create({
        name: "Logo Co",
        slug: `logo-co-${n}`,
        logo: EVIL,
      })
      expect(refusedCreate.error).toMatchObject(REFUSED)
      expect(refusedCreate.error?.message).toContain("set_organization_logo")

      const { data: org, error } = await b.client.organization.create({
        name: "Logo Co",
        slug: `logo-co-${n}`,
      })
      expect(error).toBeNull()
      if (!org) throw new Error("no organization")

      const refused = await b.client.organization.update({
        data: { logo: EVIL },
        organizationId: org.id,
      })
      expect(refused.error).toMatchObject(REFUSED)
      const [row] = await t.db
        .select({ logo: organization.logo })
        .from(organization)
        .where(eq(organization.id, org.id))
      expect(row?.logo).toBeNull()

      const renamed = await b.client.organization.update({
        data: { name: "Logo Co Renamed" },
        organizationId: org.id,
      })
      expect(renamed.error).toBeNull()
      const cleared = await b.client.organization.update({
        data: { logo: null },
        organizationId: org.id,
      })
      expect(cleared.error).toBeNull()
    })

    it("refuses a client-supplied profile image, and clears it with null", async () => {
      const { b, userId } = await signedUp("Image Person")
      const refused = await b.client.updateUser({ image: EVIL })
      expect(refused.error).toMatchObject(REFUSED)
      expect(refused.error?.message).toContain("set_my_avatar")

      const named = await b.client.updateUser({ name: "Image Renamed" })
      expect(named.error).toBeNull()
      const cleared = await b.client.updateUser({ image: null })
      expect(cleared.error).toBeNull()
      const [row] = await t.db
        .select({ image: userTable.image })
        .from(userTable)
        .where(eq(userTable.id, userId))
      expect(row?.image).toBeNull()
    })

    it("refuses a profile image at sign-up", async () => {
      const b = open()
      const { error } = await b.client.signUp.email({
        email: email(),
        password: PASSWORD,
        name: "Sign Up Image",
        image: EVIL,
      })
      expect(error).toMatchObject(REFUSED)
    })

    it("does not refuse server code: auth.api calls carry no request", async () => {
      const { b, userId } = await signedUp("Server Side")
      const headers = new Headers({ cookie: b.cookie() })
      const { data: org } = await b.client.organization.create({
        name: "Server Side Co",
        slug: `server-side-${n}`,
      })
      if (!org) throw new Error("no organization")
      await t.auth.api.updateOrganization({
        body: { data: { logo: EVIL }, organizationId: org.id },
        headers,
      })
      await t.auth.api.updateUser({ body: { image: EVIL }, headers })
      const [orgRow] = await t.db
        .select({ logo: organization.logo })
        .from(organization)
        .where(eq(organization.id, org.id))
      const [userRow] = await t.db
        .select({ image: userTable.image })
        .from(userTable)
        .where(eq(userTable.id, userId))
      expect(orgRow?.logo).toBe(EVIL)
      expect(userRow?.image).toBe(EVIL)
    })
  })

  describe("endpoints that must stay off or on", () => {
    it("keeps the session-to-JWT endpoint disabled and get-session free of JWTs", async () => {
      const { b } = await signedUp()
      expect((await b.request("/api/auth/token")).status).toBe(404)
      const session = await b.request("/api/auth/get-session")
      expect(session.status).toBe(200)
      expect(session.headers.get("set-auth-jwt")).toBeNull()
    })

    it("publishes the JWKS that OAuth access tokens are verified with", async () => {
      const res = await t.req("/api/auth/jwks")
      expect(res.status).toBe(200)
      const { keys } = (await res.json()) as { keys: { kid: string }[] }
      expect(keys.length).toBeGreaterThan(0)
    })
  })

  describe("magic links", () => {
    it("emails a sign-in link that signs the person in and records the method", async () => {
      const { b, email: address } = await signedUp()
      await b.client.signOut()

      const visitor = open()
      const { error } = await visitor.client.signIn.magicLink({
        email: address,
        callbackURL: "/welcome",
      })
      expect(error).toBeNull()
      const [mail] = await delivered(address)
      expect(mail?.link).toMatch(/^http:\/\/localhost:3000\/api\/auth\/magic-link\/verify\?token=/)

      const landing = await visitor.request(mail?.link ?? "")
      expect(landing.status).toBe(302)
      expect(landing.headers.get("location")).toBe(`${BASE}/welcome`)
      expect((await whoami(visitor)).status).toBe(200)
      expect(
        ((await visitor.client.getSession()).data?.user as { lastLoginMethod?: string } | undefined)
          ?.lastLoginMethod,
      ).toBe("magic-link")
    })

    it("refuses a link twice, and a forged one, with an error the app can show", async () => {
      const { email: address } = await signedUp()
      const visitor = open()
      await visitor.client.signIn.magicLink({ email: address, callbackURL: "/welcome" })
      const [mail] = await delivered(address, 1)
      expect((await visitor.request(mail?.link ?? "")).status).toBe(302)

      const again = await open().request(mail?.link ?? "")
      expect(again.headers.get("location")).toContain("error=INVALID_TOKEN")

      const forged = await open().request("/api/auth/magic-link/verify?token=forged")
      expect(forged.headers.get("location")).toContain("error=INVALID_TOKEN")
    })

    it("claims a provisional signup: the magic link verifies the address and ends its key", async () => {
      const address = `magic-claim-${++n}@example.com`
      const made = await t.req("/v1/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, name: "Agent" }),
      })
      const { apiKey } = (await made.json()) as { apiKey: string }
      expect((await t.req("/v1/whoami", { headers: { "x-api-key": apiKey } })).status).toBe(200)

      const visitor = open()
      await visitor.client.signIn.magicLink({ email: address, callbackURL: "/" })
      const link = (await delivered(address, 2)).find((m) =>
        m.link.includes("/magic-link/verify"),
      )?.link
      expect(link).toBeTruthy()
      expect((await visitor.request(link ?? "")).status).toBe(302)

      const stopped = await t.req("/v1/whoami", { headers: { "x-api-key": apiKey } })
      expect(stopped.status).toBe(401)
      expect(await stopped.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", hint: expect.stringContaining("device") },
      })
      expect((await whoami(visitor)).status).toBe(200)
    })
  })

  describe("magic links and two-factor", () => {
    /** A user with an authenticator enrolled, signed out. */
    async function enrolled(name: string) {
      const { b, email: address } = await signedUp(name)
      const enrol = await b.client.twoFactor.enable({ password: PASSWORD })
      const secret =
        new URL((enrol.data as { totpURI?: string } | null)?.totpURI ?? "").searchParams.get(
          "secret",
        ) ?? ""
      await b.client.twoFactor.verifyTotp({ code: totp(secret) })
      await b.client.signOut()
      return { address, secret }
    }

    /** The newest link emailed to an address, after asking for one. */
    async function requestLink(address: string, callbackURL?: string) {
      const before = inbox(address).length
      const visitor = open()
      await visitor.client.signIn.magicLink(
        callbackURL === undefined ? { email: address } : { email: address, callbackURL },
      )
      await delivered(address, before + 1)
      return { visitor, link: inbox(address).at(-1)?.link ?? "" }
    }

    it("a second-factor user who opens a link gets the code entry, not a session", async () => {
      const { address, secret } = await enrolled("Linked")
      const { visitor, link } = await requestLink(address, "/welcome")

      const landing = await visitor.request(link)
      expect(landing.status).toBe(302)
      const next = new URL(landing.headers.get("location") ?? "")
      expect(next.origin + next.pathname).toBe(`${BASE}/two-factor`)
      // The link's callbackURL is the app path it was sent with: the code entry sends the person there.
      expect(next.searchParams.get("callbackURL")).toBe("/welcome")
      expect((await whoami(visitor)).status).toBe(401)
      expect((await visitor.client.getSession()).data).toBeNull()

      const code = await visitor.client.twoFactor.verifyTotp({ code: totp(secret) })
      expect(code.error).toBeNull()
      expect((await whoami(visitor)).status).toBe(200)
    })

    it("a wrong code after a link does not open the session", async () => {
      const { address } = await enrolled("Guessed")
      const { visitor, link } = await requestLink(address, "/welcome")
      await visitor.request(link)
      const wrong = await visitor.client.twoFactor.verifyTotp({ code: "000000" })
      expect(wrong.error).toMatchObject({ status: 401 })
      expect((await whoami(visitor)).status).toBe(401)
    })

    it("a user without two-factor still signs straight in from the link", async () => {
      const { email: address } = await signedUp("Plainly")
      const { visitor, link } = await requestLink(address, "/welcome")
      const landing = await visitor.request(link)
      expect(landing.headers.get("location")).toBe(`${BASE}/welcome`)
      expect((await whoami(visitor)).status).toBe(200)
    })
  })

  describe("two-factor (TOTP)", () => {
    it("enrols an authenticator, then requires its code on the next sign-in", async () => {
      const { b, email: address } = await signedUp()
      const enabling = await b.client.twoFactor.enable({ password: PASSWORD })
      expect(enabling.error).toBeNull()
      const secret =
        new URL((enabling.data as { totpURI?: string } | null)?.totpURI ?? "").searchParams.get(
          "secret",
        ) ?? ""
      expect(secret.length).toBeGreaterThan(8)
      expect((await b.client.twoFactor.verifyTotp({ code: totp(secret) })).error).toBeNull()
      expect((await b.client.getSession()).data?.user.twoFactorEnabled).toBe(true)
      await b.client.signOut()

      const visitor = open()
      const first = await visitor.client.signIn.email({ email: address, password: PASSWORD })
      expect((first.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect).toBe(true)
      expect(first.data?.user).toBeUndefined()
      expect((await whoami(visitor)).status).toBe(401)

      const wrong = await visitor.client.twoFactor.verifyTotp({ code: "000000" })
      expect(wrong.error).toMatchObject({ status: 401 })
      const right = await visitor.client.twoFactor.verifyTotp({ code: totp(secret) })
      expect(right.error).toBeNull()
      expect((await whoami(visitor)).status).toBe(200)
    })
  })

  describe("two-factor: backup codes and trusted devices", () => {
    it("trusts a device after its second factor, and takes a backup code once", async () => {
      const { b, email: address } = await signedUp()
      const enrol = await b.client.twoFactor.enable({ password: PASSWORD })
      const secret =
        new URL((enrol.data as { totpURI?: string } | null)?.totpURI ?? "").searchParams.get(
          "secret",
        ) ?? ""
      const backupCodes = (enrol.data as { backupCodes?: string[] } | null)?.backupCodes ?? []
      expect(backupCodes.length).toBeGreaterThan(0)
      await b.client.twoFactor.verifyTotp({ code: totp(secret) })
      await b.client.signOut()

      // This browser passes the second factor once, and asks to trust the device.
      const device = open()
      await device.client.signIn.email({ email: address, password: PASSWORD })
      const trusting = await device.client.twoFactor.verifyTotp({
        code: totp(secret),
        trustDevice: true,
      })
      expect(trusting.error).toBeNull()
      await device.client.signOut()
      const again = await device.client.signIn.email({ email: address, password: PASSWORD })
      expect((again.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect).toBeFalsy()
      expect((await whoami(device)).status).toBe(200)

      // Another browser has no trusted device: a backup code gets it in, once.
      const other = open()
      const first = await other.client.signIn.email({ email: address, password: PASSWORD })
      expect((first.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect).toBe(true)
      const used = await other.client.twoFactor.verifyBackupCode({ code: backupCodes[0] ?? "" })
      expect(used.error).toBeNull()
      expect((await whoami(other)).status).toBe(200)

      const replay = await open().client.signIn.email({ email: address, password: PASSWORD })
      expect((replay.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect).toBe(true)
      const reused = await open().client.twoFactor.verifyBackupCode({
        code: backupCodes[0] ?? "",
      })
      expect(reused.error).toBeTruthy()
    })
  })

  describe("passkeys", () => {
    it("offers registration to a signed-in person only, bound to the app's host", async () => {
      const { b } = await signedUp()
      const signedIn = await b.request("/api/auth/passkey/generate-register-options")
      expect(signedIn.status).toBe(200)
      const options = (await signedIn.json()) as { challenge?: string; rp?: { id?: string } }
      expect(options.challenge).toBeTruthy()
      expect(options.rp?.id).toBe("localhost")

      const anonymous = await open().request("/api/auth/passkey/generate-register-options")
      expect(anonymous.status).toBe(401)
    })

    it("lists, renames and deletes a passkey, and only its owner may", async () => {
      // Registration needs a WebAuthn authenticator, so the row is seeded as registration would store it.
      const { b, userId } = await signedUp("Keys")
      const id = `pk-${userId}`
      await t.db.insert(passkeyTable).values({
        id,
        name: "Laptop",
        publicKey: "cHVibGljLWtleQ",
        userId,
        credentialID: `cred-${userId}`,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        transports: "internal",
        createdAt: new Date(),
        aaguid: "00000000-0000-0000-0000-000000000000",
      })
      const listed = await b.client.passkey.listUserPasskeys()
      expect(listed.data).toEqual([expect.objectContaining({ id, name: "Laptop" })])

      expect((await b.client.passkey.updatePasskey({ id, name: "Work laptop" })).error).toBeNull()

      const stranger = (await signedUp("Stranger")).b
      const denied = await stranger.client.passkey.updatePasskey({ id, name: "Hacked" })
      expect(denied.error?.status).toBeGreaterThanOrEqual(400)
      const removedByStranger = await stranger.client.passkey.deletePasskey({ id })
      expect(removedByStranger.error).toBeTruthy()
      expect((await b.client.passkey.listUserPasskeys()).data).toEqual([
        expect.objectContaining({ id, name: "Work laptop" }),
      ])

      expect((await b.client.passkey.deletePasskey({ id })).error).toBeNull()
      expect((await b.client.passkey.listUserPasskeys()).data).toEqual([])
    })
  })

  describe("sign-in with an OAuth authorization pending", () => {
    /** The query an authorization request carries, as an MCP client sends it (with PKCE). */
    async function startAuthorization() {
      const reg = await t.req("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Agent",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
        }),
      })
      const clientId = ((await reg.json()) as { client_id: string }).client_id
      const verifier = randomBytes(32).toString("base64url")
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: "openid offline_access read",
        state: "s1",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        resource: MCP,
      })
      return { clientId, verifier, query }
    }

    /** The signed query the page's client sends back (what oauthProviderClient builds). */
    const signedOAuthQuery = (search: string) => {
      const params = new URLSearchParams(search)
      const names = new Set(params.getAll("ba_param"))
      const out = new URLSearchParams()
      for (const [k, v] of params)
        if (k === "sig" || k === "ba_param" || names.has(k)) out.append(k, v)
      return out.toString()
    }

    /** Authorization goes to the sign-in page first; returns that page's signed query. */
    async function toSignIn(b: ReturnType<typeof open>, query: URLSearchParams) {
      const res = await b.request(`/api/auth/oauth2/authorize?${query}`)
      const login = new URL(res.headers.get("location") ?? "", BASE)
      expect(login.pathname).toBe("/sign-in")
      return signedOAuthQuery(login.search)
    }

    /** Accept consent on the pending authorization, then exchange the code for a token. */
    async function finish(
      b: ReturnType<typeof open>,
      next: URL,
      a: { clientId: string; verifier: string },
    ) {
      const consent = await b.request("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true, oauth_query: next.search.slice(1) }),
      })
      const { url } = (await consent.json()) as { url: string }
      const code = new URL(url).searchParams.get("code") ?? ""
      const token = await t.req("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: a.clientId,
          code_verifier: a.verifier,
          resource: MCP,
        }),
      })
      const body = (await token.json()) as { access_token?: string }
      expect(body.access_token).toBeTruthy()
      return body.access_token ?? ""
    }

    it("keeps delete-consent off: it would leave the agent's refresh token standing", async () => {
      const { b: owner } = await signedUp("Consenting")
      const a = await startAuthorization()
      const first = await owner.request(`/api/auth/oauth2/authorize?${a.query}`)
      await finish(owner, new URL(first.headers.get("location") ?? "", BASE), a)
      const db = (await t.auth.$context).adapter
      const where = [{ field: "clientId", value: a.clientId }]
      const consent = await db.findOne<{ id: string }>({ model: "oauthConsent", where })
      expect(consent).not.toBeNull()

      const res = await owner.request("/api/auth/oauth2/delete-consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: consent?.id }),
      })
      expect(res.status).toBe(404)
      expect(await db.findOne({ model: "oauthConsent", where })).not.toBeNull()
    })

    it("resumes the authorization after a magic-link sign-in", async () => {
      const { email: address } = await signedUp("Mara")
      const a = await startAuthorization()
      const b = open()
      const oauthQuery = await toSignIn(b, a.query)

      const sent = await b.request("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, callbackURL: "/", oauth_query: oauthQuery }),
      })
      expect(sent.status).toBe(200)
      const [mail] = await delivered(address)

      // The emailed link opens in the same browser, which still holds the pending authorization.
      // The link carries the authorization to the authorize endpoint, which now has a session.
      const landing = await b.request(mail?.link ?? "")
      expect(landing.status).toBe(302)
      const resumed = await b.request(landing.headers.get("location") ?? "")
      expect(resumed.status).toBe(302)
      const next = new URL(resumed.headers.get("location") ?? "", BASE)
      expect(next.pathname).toBe("/consent")

      const accessToken = await finish(b, next, a)
      const { decodeJwt } = await import("jose")
      expect(decodeJwt(accessToken).org).toBeTruthy()
    })

    it("refuses a forged authorization query on a magic-link sign-in", async () => {
      const { email: address } = await signedUp()
      const a = await startAuthorization()
      const forged = (await toSignIn(open(), a.query)).replace(/sig=[^&]+/, "sig=forged")
      const res = await open().request("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, callbackURL: "/", oauth_query: forged }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: "invalid_signature" })
      expect(inbox(address)).toHaveLength(0)
    })

    it("sends a failed link back to sign-in, where the person can see why", async () => {
      const { email: address } = await signedUp()
      const a = await startAuthorization()
      const b = open()
      const oauthQuery = await toSignIn(b, a.query)
      await b.request("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, callbackURL: "/", oauth_query: oauthQuery }),
      })
      const [mail] = await delivered(address)
      const broken = new URL(mail?.link ?? "")
      broken.searchParams.set("token", "forged")
      const landing = await b.request(`${broken.pathname}${broken.search}`)
      const next = new URL(landing.headers.get("location") ?? "", BASE)
      expect(next.pathname).toBe("/sign-in")
      expect(next.searchParams.get("error")).toBe("INVALID_TOKEN")
    })

    it("an impersonated session gets no code, even for an authorization the user already granted", async () => {
      const { b: owner, userId: ownerId } = await signedUp("Granted")
      const a = await startAuthorization()
      const first = await owner.request(`/api/auth/oauth2/authorize?${a.query}`)
      await finish(owner, new URL(first.headers.get("location") ?? "", BASE), a)

      const { b: admin, userId: adminId } = await signedUp("Root")
      await (await t.auth.$context).adapter.updateMany({
        model: "user",
        where: [{ field: "id", value: adminId }],
        update: { role: "admin" },
      })
      expect((await admin.client.admin.impersonateUser({ userId: ownerId })).error).toBeNull()

      const again = await admin.request(`/api/auth/oauth2/authorize?${a.query}`)
      expect(again.status).toBe(403)
      expect(await again.json()).toMatchObject({ code: "IMPERSONATED_SESSION_NOT_ALLOWED" })
      expect(again.headers.get("location")).toBeNull()
    })

    it("resumes the authorization after the second factor", async () => {
      const { b: owner, email: address } = await signedUp("Tofu")
      const enrol = await owner.client.twoFactor.enable({ password: PASSWORD })
      const secret =
        new URL((enrol.data as { totpURI?: string } | null)?.totpURI ?? "").searchParams.get(
          "secret",
        ) ?? ""
      await owner.client.twoFactor.verifyTotp({ code: totp(secret) })
      await owner.client.signOut()

      const a = await startAuthorization()
      const b = open()
      const oauthQuery = await toSignIn(b, a.query)
      const first = await b.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, password: PASSWORD, oauth_query: oauthQuery }),
      })
      expect(((await first.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true)

      const second = await b.request("/api/auth/two-factor/verify-totp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The two-factor page keeps its query, so the app sends it back with the code.
        body: JSON.stringify({ code: totp(secret), oauth_query: oauthQuery }),
      })
      const text = await second.text()
      const location = second.headers.get("location") ?? (JSON.parse(text) as { url?: string }).url
      const next = new URL(location ?? "", BASE)
      expect(next.pathname).toBe("/consent")

      const accessToken = await finish(b, next, a)
      const { decodeJwt } = await import("jose")
      expect(decodeJwt(accessToken).org).toBeTruthy()
    })
  })

  describe("GitHub and Google sign-in (provider fetches faked)", () => {
    let s: Awaited<ReturnType<typeof createTestApp>>
    let githubEmail = ""
    /** GitHub's id for the account is per address, as it would be for real people. */
    const githubAccountId = () =>
      Array.from(githubEmail).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
    const realFetch = globalThis.fetch
    const social = () => browser((url, init) => s.app.request(url, init))

    beforeAll(async () => {
      s = await createTestApp([], { github: { clientId: "gh-client", clientSecret: "gh-secret" } })
      // GitHub's token and profile endpoints, answered for the address under test.
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        const json = (body: unknown) =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )
        if (url === "https://github.com/login/oauth/access_token")
          return json({ access_token: "gho_test", token_type: "bearer", scope: "user:email" })
        if (url === "https://api.github.com/user")
          return json({
            id: githubAccountId(),
            login: "octo",
            name: "Octo Cat",
            email: githubEmail,
            avatar_url: "",
          })
        if (url === "https://api.github.com/user/emails")
          return json([{ email: githubEmail, primary: true, verified: true }])
        return realFetch(input, init)
      })
    })
    afterAll(async () => {
      vi.unstubAllGlobals()
      await s.close()
    })

    it("offers only the providers that are configured", async () => {
      const b = social()
      const google = await b.client.signIn.social({ provider: "google", callbackURL: "/" })
      expect(google.error).toBeTruthy()
      const github = await b.client.signIn.social({ provider: "github", callbackURL: "/" })
      expect(github.error).toBeNull()
      const authorize = new URL(github.data?.url ?? "")
      expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize")
      expect(authorize.searchParams.get("client_id")).toBe("gh-client")
    })

    it("signs a new GitHub address up into a personal organization", async () => {
      const address = `octo-new-${++n}@example.com`
      githubEmail = address
      const b = social()
      const start = await b.client.signIn.social({ provider: "github", callbackURL: "/welcome" })
      const state = new URL(start.data?.url ?? "").searchParams.get("state") ?? ""
      const back = await b.request(`/api/auth/callback/github?code=test-code&state=${state}`)
      expect(back.status).toBe(302)
      expect(new URL(back.headers.get("location") ?? "", BASE).pathname).toBe("/welcome")

      const { data: session } = await b.client.getSession()
      expect(session?.user.email).toBe(address)
      expect(session?.session.activeOrganizationId).toBeTruthy()
      expect((await whoami(b)).status).toBe(200)
      expect((session?.user as { lastLoginMethod?: string } | undefined)?.lastLoginMethod).toBe(
        "github",
      )
      expect(
        (session?.session as unknown as { loginMethod?: string } | undefined)?.loginMethod,
      ).toBe("github")
    })

    it("cannot claim a provisional signup: the same address on GitHub is refused, the key stays on", async () => {
      // Linking to an account whose address isn't verified yet is refused (better-auth's
      // requireLocalEmailVerified default), so a social login can't take over a provisional account.
      const address = `octo-claim-${++n}@example.com`
      githubEmail = address
      const made = await s.req("/v1/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, name: "Octo" }),
      })
      const { apiKey } = (await made.json()) as { apiKey: string }

      const b = social()
      const start = await b.client.signIn.social({ provider: "github", callbackURL: "/welcome" })
      const state = new URL(start.data?.url ?? "").searchParams.get("state") ?? ""
      const back = await b.request(`/api/auth/callback/github?code=test-code&state=${state}`)
      expect(new URL(back.headers.get("location") ?? "", BASE).searchParams.get("error")).toBe(
        "account_not_linked",
      )
      expect((await whoami(b)).status).toBe(SIGNED_OUT.status)

      expect((await s.req("/v1/whoami", { headers: { "x-api-key": apiKey } })).status).toBe(200)
    })

    describe("connected accounts", () => {
      /** A browser on the GitHub app, signed up by email with `address`. */
      async function signedUpHere(address: string) {
        const b = social()
        const { error } = await b.client.signUp.email({
          email: address,
          password: PASSWORD,
          name: "Octo",
        })
        if (error) throw new Error(`sign-up failed: ${JSON.stringify(error)}`)
        return b
      }

      /** Connect GitHub to the signed-in account, as the Security page does: the provider's callback links it. */
      async function connectGithub(b: ReturnType<typeof social>, callbackURL: string) {
        const start = await b.client.linkSocial({ provider: "github", callbackURL })
        const state = new URL(start.data?.url ?? "").searchParams.get("state") ?? ""
        return b.request(`/api/auth/callback/github?code=test-code&state=${state}`)
      }

      it("an impersonated session cannot start linking GitHub to the victim's account", async () => {
        const victimId =
          (await (await signedUpHere(`octo-victim-${++n}@example.com`)).client.getSession()).data
            ?.user.id ?? ""
        const root = await signedUpHere(`octo-root-${++n}@example.com`)
        const rootId = (await root.client.getSession()).data?.user.id ?? ""
        await (await s.auth.$context).adapter.updateMany({
          model: "user",
          where: [{ field: "id", value: rootId }],
          update: { role: "admin" },
        })
        expect((await root.client.admin.impersonateUser({ userId: victimId })).error).toBeNull()

        const linked = await root.request("/api/auth/link-social", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "github", callbackURL: "/security" }),
        })
        expect(linked.status).toBe(403)
        expect(await linked.json()).toMatchObject({ code: "IMPERSONATED_SESSION_NOT_ALLOWED" })
      })

      it("connects GitHub to a signed-in account, lists it, and disconnects it", async () => {
        const address = `octo-link-${++n}@example.com`
        githubEmail = address
        const b = await signedUpHere(address)

        const back = await connectGithub(b, "/security")
        expect(back.status).toBe(302)
        expect(new URL(back.headers.get("location") ?? "", BASE).pathname).toBe("/security")

        const { data: accounts } = await b.client.listAccounts()
        expect(accounts?.map((a) => a.providerId).sort()).toEqual(["credential", "github"])
        const github = accounts?.find((a) => a.providerId === "github")
        expect((await b.client.unlinkAccount({ accountId: github?.id ?? "" })).error).toBeNull()
        const { data: left } = await b.client.listAccounts()
        expect(left?.map((a) => a.providerId)).toEqual(["credential"])
      })

      it("refuses to connect a GitHub account under a different address", async () => {
        const address = `octo-mismatch-${++n}@example.com`
        githubEmail = `someone-else-${n}@example.com`
        const b = await signedUpHere(address)

        const back = await connectGithub(b, "/security")
        expect(
          new URL(back.headers.get("location") ?? "", BASE).searchParams.get("error"),
        ).toBeTruthy()
        const { data: accounts } = await b.client.listAccounts()
        expect(accounts?.map((a) => a.providerId)).toEqual(["credential"])
      })

      it("keeps the last way in: a password with nothing else to sign in with can't be disconnected", async () => {
        const b = await signedUpHere(`octo-last-${++n}@example.com`)
        const { data: accounts } = await b.client.listAccounts()
        const credential = accounts?.find((a) => a.providerId === "credential")
        const refused = await b.client.unlinkAccount({ accountId: credential?.id ?? "" })
        expect(refused.error).toMatchObject({ status: 400, code: "LAST_SIGN_IN_METHOD" })
        expect((await whoami(b)).status).toBe(200)
      })

      it("a GitHub-only account can drop GitHub once a passkey is its way in", async () => {
        const address = `octo-only-${++n}@example.com`
        githubEmail = address
        const b = social()
        const start = await b.client.signIn.social({ provider: "github", callbackURL: "/welcome" })
        const state = new URL(start.data?.url ?? "").searchParams.get("state") ?? ""
        await b.request(`/api/auth/callback/github?code=test-code&state=${state}`)
        const { data: session } = await b.client.getSession()
        const { data: accounts } = await b.client.listAccounts()
        expect(accounts?.map((a) => a.providerId)).toEqual(["github"])
        const github = accounts?.[0]?.id ?? ""

        const refused = await b.client.unlinkAccount({ accountId: github })
        expect(refused.error).toMatchObject({ code: "LAST_SIGN_IN_METHOD" })

        await s.db.insert(passkeyTable).values({
          id: `pk-octo-${++n}`,
          name: "Phone",
          publicKey: "cHVibGljLWtleQ",
          userId: session?.user.id ?? "",
          credentialID: `cred-octo-${n}`,
          counter: 0,
          deviceType: "multiDevice",
          backedUp: true,
          transports: "internal",
          createdAt: new Date(),
          aaguid: "00000000-0000-0000-0000-000000000000",
        })
        expect((await b.client.unlinkAccount({ accountId: github })).error).toBeNull()
        expect((await whoami(b)).status).toBe(200)
      })
    })
  })

  describe("impersonation", () => {
    it("an impersonated session is read-only and cannot create keys or consent", async () => {
      const { b: admin, userId: adminId } = await signedUp("Root")
      const { userId: victimId } = await signedUp("Victim")
      const ctx = await t.auth.$context
      await ctx.adapter.updateMany({
        model: "user",
        where: [{ field: "id", value: adminId }],
        update: { role: "admin" },
      })
      // Impersonation starts from the admin's own session.
      const start = await admin.client.admin.impersonateUser({ userId: victimId })
      expect(start.error).toBeNull()

      const session = await admin.client.getSession()
      expect(session.data?.user.id).toBe(victimId)
      expect(await whoami(admin)).toMatchObject({ status: 200 })

      const key = await admin.request("/api/auth/api-key/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Sneaky", permissions: { project: ["read"] } }),
      })
      expect(key.status).toBe(403)
      expect(await key.json()).toMatchObject({ code: "IMPERSONATED_SESSION_NOT_ALLOWED" })

      const consent = await admin.request("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true }),
      })
      expect(consent.status).toBe(403)
      expect(await consent.json()).toMatchObject({ code: "IMPERSONATED_SESSION_NOT_ALLOWED" })

      const viaApi = await admin.request("/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Sneaky", permissions: { project: ["read"] } }),
      })
      expect(viaApi.status).toBe(403)
      expect(await viaApi.json()).toMatchObject({ error: { code: "FORBIDDEN" } })
    })
  })

  describe("impersonation is read-only", () => {
    const post = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

    it("refuses every write and every GET that mints or links, and keeps the reads", async () => {
      const { b: admin, email: adminEmail, userId: adminId } = await signedUp("Root read-only")
      const victim = await signedUp("Victim read-only")
      const org = (await whoami(victim.b)).body.organizationId ?? ""
      // A second session of the victim: a refused revoke-other-sessions must leave it signed in.
      const phone = open()
      await phone.client.signIn.email({ email: victim.email, password: PASSWORD })
      await (await t.auth.$context).adapter.updateMany({
        model: "user",
        where: [{ field: "id", value: adminId }],
        update: { role: "admin" },
      })
      expect((await admin.client.admin.impersonateUser({ userId: victim.userId })).error).toBeNull()

      const moved = "victim-moved@example.com"
      const attempts: [string, string, RequestInit?][] = [
        [
          "POST",
          "/organization/invite-member",
          post({ email: adminEmail, role: "owner", organizationId: org }),
        ],
        ["POST", "/organization/create", post({ name: "Sneaky", slug: "sneaky-read-only" })],
        ["GET", "/passkey/generate-register-options"],
        ["POST", "/change-email", post({ newEmail: moved })],
        ["POST", "/update-user", post({ name: "Changed by admin" })],
        ["POST", "/revoke-other-sessions", post({})],
        [
          "POST",
          "/organization/update-member-role",
          post({ memberId: "none", role: "owner", organizationId: org }),
        ],
        ["POST", "/organization/delete", post({ organizationId: org })],
        [
          "POST",
          "/oauth2/create-client",
          post({ client_name: "Sneaky", redirect_uris: ["http://127.0.0.1/cb"] }),
        ],
        ["POST", "/api-key/delete", post({ keyId: "none" })],
        ["POST", "/delete-user", post({})],
      ]
      for (const [method, path, init] of attempts) {
        const res = await admin.request(`/api/auth${path}`, method === "GET" ? undefined : init)
        expect(res.status, `${method} ${path}`).toBe(403)
        expect(await res.json(), `${method} ${path}`).toMatchObject({
          code: "IMPERSONATED_SESSION_NOT_ALLOWED",
        })
      }
      // The refused email change sent nothing, and the victim's data and sessions are as they were.
      expect(inbox(moved)).toHaveLength(0)
      expect((await phone.client.getSession()).data?.user.id).toBe(victim.userId)
      const seen = (await admin.client.getSession()).data
      expect(seen?.user.id).toBe(victim.userId)
      expect(seen?.user.name).toBe("Victim read-only")
      expect(seen?.user.email).toBe(victim.email)

      // Reads still work while impersonating.
      expect((await admin.request("/api/auth/list-sessions")).status).toBe(200)
      expect((await admin.request("/api/auth/passkey/list-user-passkeys")).status).toBe(200)
      expect((await admin.request("/api/auth/organization/list")).status).toBe(200)
      // The product's reads (read-only grants) answer through the same session.
      for (const path of ["/v1/projects", "/v1/api-keys", "/v1/workspace-agents", "/v1/runs"]) {
        expect((await admin.request(path)).status, path).toBe(200)
      }

      // Stopping, and signing out, are the two things the impersonation may still do.
      expect((await admin.client.admin.stopImpersonating()).error).toBeNull()
      expect((await admin.client.getSession()).data?.user.id).toBe(adminId)
    })

    it("a signed-out impersonation ends with sign-out", async () => {
      const { b: admin, userId: adminId } = await signedUp("Root sign-out")
      const victim = await signedUp("Victim sign-out")
      await (await t.auth.$context).adapter.updateMany({
        model: "user",
        where: [{ field: "id", value: adminId }],
        update: { role: "admin" },
      })
      expect((await admin.client.admin.impersonateUser({ userId: victim.userId })).error).toBeNull()
      expect((await admin.client.signOut()).error).toBeNull()
      expect((await admin.client.getSession()).data).toBeNull()
    })
  })

  describe("impersonation and the device grant", () => {
    it("an impersonated session cannot approve a device code, so no token is issued", async () => {
      const { userId: ownerId } = await signedUp("Device owner")
      const { b: admin, userId: adminId } = await signedUp("Root device")
      await (await t.auth.$context).adapter.updateMany({
        model: "user",
        where: [{ field: "id", value: adminId }],
        update: { role: "admin" },
      })
      expect((await admin.client.admin.impersonateUser({ userId: ownerId })).error).toBeNull()

      const registered = await t.req("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Device CLI",
          token_endpoint_auth_method: "none",
          grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        }),
      })
      const clientId = ((await registered.json()) as { client_id: string }).client_id
      const device = await t.req("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, scope: "read offline_access" }),
      })
      const { device_code, user_code } = (await device.json()) as {
        device_code: string
        user_code: string
      }

      // Checking the code claims it for the session's user, so it is refused too.
      const check = await admin.request(`/api/auth/device?user_code=${user_code}`)
      expect(check.status).toBe(403)
      expect(await check.json()).toMatchObject({ code: "IMPERSONATED_SESSION_NOT_ALLOWED" })

      const approve = await admin.request("/api/auth/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: user_code }),
      })
      expect(approve.status).toBe(403)
      expect(await approve.json()).toMatchObject({ code: "IMPERSONATED_SESSION_NOT_ALLOWED" })

      // Nothing was approved, so the client is still told to wait.
      const poll = await t.req("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code,
          client_id: clientId,
        }),
      })
      expect(poll.status).toBe(400)
      expect(await poll.json()).toMatchObject({ error: "authorization_pending" })
    })
  })

  describe("owner-only single sign-on, SCIM and billing", () => {
    let org: string
    let owner: Awaited<ReturnType<typeof signedUp>>
    const roleUsers: Record<"member" | "viewer" | "admin", ReturnType<typeof open>> = {
      member: open(),
      viewer: open(),
      admin: open(),
    }

    beforeAll(async () => {
      owner = await signedUp("Owner of SSO")
      org = (await whoami(owner.b)).body.organizationId ?? ""
      for (const role of ["member", "viewer", "admin"] as const) {
        const user = await signedUp(`Ruled ${role}`)
        roleUsers[role] = user.b
        await t.auth.api.addMember({
          body: { organizationId: org, userId: user.userId, role },
        })
      }
    })

    const json = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

    const providerBody = (providerId: string) => ({
      providerId,
      issuer: "https://idp.acme.test",
      domain: "acme.test",
      organizationId: org,
      oidcConfig: {
        clientId: "acme-client",
        clientSecret: "acme-secret", // gitleaks:allow
        authorizationEndpoint: "https://idp.acme.test/authorize",
        tokenEndpoint: "https://idp.acme.test/token",
        jwksEndpoint: "https://idp.acme.test/jwks",
        skipDiscovery: true,
      },
    })

    it("lets the owner register an SSO provider for the organization", async () => {
      const res = await owner.b.request("/api/auth/sso/register", json(providerBody("acme-owner")))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ providerId: "acme-owner" })
    })

    it("refuses SSO registration to an admin, a member and a viewer of the same organization", async () => {
      for (const role of ["admin", "member", "viewer"] as const) {
        const res = await roleUsers[role].request(
          "/api/auth/sso/register",
          json(providerBody(`acme-${role}`)),
        )
        expect(res.status, role).toBe(403)
        expect(await res.json(), role).toMatchObject({ code: "ORGANIZATION_OWNER_REQUIRED" })
      }
    })

    it("gives the owner a DNS TXT record to prove the provider's domain", async () => {
      const res = await owner.b.request(
        "/api/auth/sso/request-domain-verification",
        json({ providerId: "acme-owner" }),
      )
      expect(res.status).toBe(201)
      const { domainVerificationToken } = (await res.json()) as { domainVerificationToken: string }
      expect(domainVerificationToken.length).toBeGreaterThan(16)
      // The record the owner adds is _better-auth-token-<providerId>.<domain>, valued with the token.
      // The plugin keeps the pending token under the identifier "_better-auth-token-<providerId>".
      const [pending] = await t.db
        .select()
        .from(verification)
        .where(eq(verification.identifier, "_better-auth-token-acme-owner"))
      expect(pending?.value).toBe(domainVerificationToken)

      // Asking again while the token is live returns the same one.
      const again = await owner.b.request(
        "/api/auth/sso/request-domain-verification",
        json({ providerId: "acme-owner" }),
      )
      expect(await again.json()).toEqual({ domainVerificationToken })
    })

    it("refuses an unverified domain: the check fails and sign-in by that domain is refused", async () => {
      // No TXT record exists for acme.test, so the proof fails (the resolver is the real DNS here).
      const check = await owner.b.request(
        "/api/auth/sso/verify-domain",
        json({ providerId: "acme-owner" }),
      )
      expect(check.status).not.toBe(204)
      expect(check.status).toBeGreaterThanOrEqual(400)

      const sso = await open().request(
        "/api/auth/sign-in/sso",
        json({ email: "ada@acme.test", callbackURL: "/" }),
      )
      expect(sso.status).toBe(401)
      expect(await sso.json()).toMatchObject({ message: "Provider domain has not been verified" })
    })

    it("refuses domain verification to an admin, a member and a viewer", async () => {
      for (const path of ["request-domain-verification", "verify-domain"] as const) {
        for (const role of ["admin", "member", "viewer"] as const) {
          const res = await roleUsers[role].request(
            `/api/auth/sso/${path}`,
            json({ providerId: "acme-owner" }),
          )
          expect(res.status, `${role} ${path}`).toBe(403)
          expect(await res.json(), `${role} ${path}`).toMatchObject({
            code: "ORGANIZATION_OWNER_REQUIRED",
          })
        }
      }
    })

    it("mints a SCIM token for the owner only, and the token opens the SCIM API", async () => {
      const res = await owner.b.request(
        "/api/auth/scim/generate-token",
        json({ organizationId: org }),
      )
      expect(res.status).toBe(200)
      const { token } = (await res.json()) as { token: string }
      expect(token.length).toBeGreaterThan(20)

      const scim = await owner.b.request("/api/auth/scim/v2/Users", {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(scim.status).toBe(200)
    })

    it("refuses a SCIM token to an admin, a member and a viewer", async () => {
      for (const role of ["admin", "member", "viewer"] as const) {
        const res = await roleUsers[role].request(
          "/api/auth/scim/generate-token",
          json({ organizationId: org }),
        )
        expect(res.status, role).toBe(403)
        expect(await res.json(), role).toMatchObject({ code: "ORGANIZATION_OWNER_REQUIRED" })
      }
    })

    it("refuses a SCIM token for an organization the caller is not in", async () => {
      const res = await roleUsers.member.request(
        "/api/auth/scim/generate-token",
        json({ organizationId: owner.userId }),
      )
      expect(res.status).toBe(403)
    })

    it("with Stripe unset, the billing endpoints are absent", async () => {
      for (const path of ["/api/auth/stripe/webhook", "/api/auth/subscription/upgrade"]) {
        const res = await owner.b.request(path, json({ referenceId: org }))
        expect(res.status, path).toBe(404)
      }
    })
  })

  describe("SCIM tokens and membership", () => {
    const json = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

    /** An owner who mints a SCIM token, and a second owner to remove or replace them. */
    async function ownerWithToken(name: string) {
      const departing = await signedUp(`${name} departing`)
      const org = (await whoami(departing.b)).body.organizationId ?? ""
      const heir = await signedUp(`${name} heir`)
      await t.auth.api.addMember({
        body: { organizationId: org, userId: heir.userId, role: "owner" },
      })
      const minted = await departing.b.request(
        "/api/auth/scim/generate-token",
        json({ organizationId: org }),
      )
      expect(minted.status).toBe(200)
      const { token, connectionId } = (await minted.json()) as {
        token: string
        connectionId: string
      }
      const scim = (bearer: string) =>
        departing.b.request("/api/auth/scim/v2/Users", {
          headers: { authorization: `Bearer ${bearer}` },
        })
      expect((await scim(token)).status).toBe(200)
      return { departing, heir, org, token, connectionId, scim }
    }

    it("a removed owner's SCIM token stops working at once", async () => {
      const { departing, heir, org, token, scim } = await ownerWithToken("Removed")
      const removed = await heir.b.request(
        "/api/auth/organization/remove-member",
        json({ memberIdOrEmail: departing.email, organizationId: org }),
      )
      expect(removed.status).toBe(200)
      expect((await scim(token)).status).toBe(401)
    })

    it("an owner who leaves the organization takes their SCIM token with them", async () => {
      const { departing, org, token, scim } = await ownerWithToken("Leaving")
      const left = await departing.b.request(
        "/api/auth/organization/leave",
        json({ organizationId: org }),
      )
      expect(left.status).toBe(200)
      expect((await scim(token)).status).toBe(401)
    })
  })

  describe("SCIM tokens and account deletion", () => {
    const json = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

    it("deleting the token's creator ends the token", async () => {
      // A sole member of their own personal organization: nothing else depends on it.
      const departing = await signedUp("Solo")
      const org = (await whoami(departing.b)).body.organizationId ?? ""
      const minted = await departing.b.request(
        "/api/auth/scim/generate-token",
        json({ organizationId: org }),
      )
      expect(minted.status).toBe(200)
      const { token } = (await minted.json()) as { token: string }
      const scim = () =>
        departing.b.request("/api/auth/scim/v2/Users", {
          headers: { authorization: `Bearer ${token}` },
        })
      expect((await scim()).status).toBe(200)
      // Deletion is confirmed by the emailed link, as in the delete-account tests.
      const asked = await departing.b.client.deleteUser({ callbackURL: "/goodbye" })
      expect(asked.error).toBeNull()
      const confirm = await mailed(departing.email, "Confirm deleting your Proof account")
      expect((await departing.b.request(confirm.link)).status).toBe(302)
      expect((await scim()).status).toBe(401)
    })
  })

  describe("SCIM provisioning into the organization", () => {
    const json = (body: unknown, method = "POST") => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User"
    const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp"

    /** An owner with a SCIM token for their org, and a `scim` request helper bound to that token. */
    async function ownerWithScim(name: string) {
      const owner = await signedUp(`${name} owner`)
      const org = (await whoami(owner.b)).body.organizationId ?? ""
      const minted = await owner.b.request(
        "/api/auth/scim/generate-token",
        json({ organizationId: org }),
      )
      expect(minted.status).toBe(200)
      const { token, connectionId } = (await minted.json()) as {
        token: string
        connectionId: string
      }
      // Over HTTP for every method: an identity provider deprovisions with PATCH and DELETE.
      const scim = (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers)
        headers.set("authorization", `Bearer ${token}`)
        return owner.b.request(`/api/auth/scim/v2${path}`, { ...init, headers })
      }
      return { owner, org, token, connectionId, scim }
    }

    /** The organization's member row for a person, by email, or null. */
    async function memberOf(address: string, org: string) {
      const [row] = await t.db
        .select({ role: member.role })
        .from(member)
        .innerJoin(userTable, eq(userTable.id, member.userId))
        .where(and(eq(userTable.email, address), eq(member.organizationId, org)))
      return row ?? null
    }

    it("a provisioned user becomes a member, loses it on deactivation and regains it on reactivation", async () => {
      const { org, scim } = await ownerWithScim("Provision")
      const address = email()
      const created = await scim(
        "/Users",
        json({
          schemas: [SCIM_USER],
          userName: address,
          displayName: "New Hire",
          emails: [{ value: address, primary: true }],
          active: true,
        }),
      )
      expect(created.status).toBe(201)
      const { id: scimId } = (await created.json()) as { id: string }
      expect(await memberOf(address, org)).toEqual({ role: "member" })

      const off = await scim(
        `/Users/${scimId}`,
        json(
          { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] },
          "PATCH",
        ),
      )
      expect(off.status).toBe(200)
      expect(await memberOf(address, org)).toBeNull()

      const on = await scim(
        `/Users/${scimId}`,
        json(
          { schemas: [PATCH], Operations: [{ op: "replace", value: { active: true } }] },
          "PATCH",
        ),
      )
      expect(on.status).toBe(200)
      expect(await memberOf(address, org)).toEqual({ role: "member" })
    })

    // Seats (packages/auth/src/entitlements.ts): the projection checks the plan inside the
    // directory's transaction; a refusal fails the SCIM write and leaves nothing behind.
    it("refuses provisioning past the Free plan's seats, and keeps neither the member nor the user", async () => {
      const { org, scim } = await ownerWithScim("Full")
      for (const name of ["Second", "Third"]) {
        const extra = await signedUp(`Full ${name}`)
        await t.auth.api.addMember({
          body: { organizationId: org, userId: extra.userId, role: "member" },
        })
      }
      const address = email()
      const created = await scim(
        "/Users",
        json({
          schemas: [SCIM_USER],
          userName: address,
          displayName: "One Too Many",
          emails: [{ value: address, primary: true }],
          active: true,
        }),
      )
      expect(created.status).toBeGreaterThanOrEqual(400)
      expect(await memberOf(address, org)).toBeNull()
      const users = await t.db.select().from(userTable).where(eq(userTable.email, address))
      expect(users).toEqual([])
    })

    it("a DELETE of the SCIM user removes the membership", async () => {
      const { org, scim } = await ownerWithScim("Delete")
      const address = email()
      const created = await scim(
        "/Users",
        json({
          schemas: [SCIM_USER],
          userName: address,
          emails: [{ value: address, primary: true }],
          active: true,
        }),
      )
      const { id: scimId } = (await created.json()) as { id: string }
      expect(await memberOf(address, org)).toEqual({ role: "member" })
      const gone = await scim(`/Users/${scimId}`, { method: "DELETE" })
      expect(gone.status).toBe(204)
      expect(await memberOf(address, org)).toBeNull()
    })

    it("a directory deprovisioning drops the member's notices for that organization, and keeps the rest", async () => {
      const { org, scim } = await ownerWithScim("Notices")
      const provision = async (address: string) => {
        const created = await scim(
          "/Users",
          json({
            schemas: [SCIM_USER],
            userName: address,
            emails: [{ value: address, primary: true }],
            active: true,
          }),
        )
        expect(created.status).toBe(201)
        return ((await created.json()) as { id: string }).id
      }
      const leaving = email()
      const staying = email()
      const leavingScimId = await provision(leaving)
      await provision(staying)
      const idOf = async (address: string) =>
        (
          await t.db
            .select({ id: userTable.id })
            .from(userTable)
            .where(eq(userTable.email, address))
        )[0]?.id ?? ""
      const leavingId = await idOf(leaving)
      const stayingId = await idOf(staying)

      // Seeding is setup: the server writes the rows the way the features do.
      await t.auth.api.notify({
        body: { userId: leavingId, organizationId: org, type: "approval.requested", title: "Org" },
      })
      await t.auth.api.notify({
        body: { userId: leavingId, type: "account.password_changed", title: "Personal" },
      })
      await t.auth.api.notify({
        body: {
          userId: stayingId,
          organizationId: org,
          type: "approval.requested",
          title: "Stays",
        },
      })
      const titlesOf = async (userId: string) =>
        (
          await t.db
            .select({ title: notification.title })
            .from(notification)
            .where(eq(notification.userId, userId))
        )
          .map((row) => row.title)
          .sort()
      expect(await titlesOf(leavingId)).toEqual(["Org", "Personal"])

      const off = await scim(
        `/Users/${leavingScimId}`,
        json(
          { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] },
          "PATCH",
        ),
      )
      expect(off.status).toBe(200)
      expect(await memberOf(leaving, org)).toBeNull()
      // The organization's notices go with the membership; the personal one does not.
      expect(await titlesOf(leavingId)).toEqual(["Personal"])
      expect(await titlesOf(stayingId)).toEqual(["Stays"])
    })

    it("a directory deprovisioning removes only what it provisioned: a member an owner added by hand stays", async () => {
      const { owner, org, scim } = await ownerWithScim("Hand-made kept")
      // SCIM refuses an address that already has an account, so the directory provisions first.
      const handMade = email()
      const listed = await scim(
        "/Users",
        json({
          schemas: [SCIM_USER],
          userName: handMade,
          emails: [{ value: handMade, primary: true }],
          active: true,
        }),
      )
      expect(listed.status).toBe(201)
      const { id: listedId } = (await listed.json()) as { id: string }
      expect(await memberOf(handMade, org)).toEqual({ role: "member" })

      // The owner takes the membership back and adds the person by hand: no SCIM source now.
      const [row] = await t.db
        .select({ id: member.id, userId: member.userId })
        .from(member)
        .innerJoin(userTable, eq(userTable.id, member.userId))
        .where(and(eq(userTable.email, handMade), eq(member.organizationId, org)))
      const removed = await owner.b.client.organization.removeMember({
        memberIdOrEmail: row?.id ?? "",
        organizationId: org,
      })
      expect(removed.error).toBeNull()
      await t.auth.api.addMember({
        body: { organizationId: org, userId: row?.userId ?? "", role: "member" },
      })
      expect(await memberOf(handMade, org)).toEqual({ role: "member" })

      // The directory deactivates the person: the hand-made membership stays.
      const off = await scim(
        `/Users/${listedId}`,
        json(
          { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] },
          "PATCH",
        ),
      )
      expect(off.status).toBe(200)
      expect(await memberOf(handMade, org)).toEqual({ role: "member" })

      // A member the directory created itself is removed by the same deactivation.
      const address = email()
      const created = await scim(
        "/Users",
        json({
          schemas: [SCIM_USER],
          userName: address,
          emails: [{ value: address, primary: true }],
          active: true,
        }),
      )
      const { id: createdId } = (await created.json()) as { id: string }
      expect(await memberOf(address, org)).toEqual({ role: "member" })
      const gone = await scim(
        `/Users/${createdId}`,
        json(
          { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] },
          "PATCH",
        ),
      )
      expect(gone.status).toBe(200)
      expect(await memberOf(address, org)).toBeNull()
    })

    it("a directory that deactivates an owner leaves them an owner, and the SCIM token still works", async () => {
      const { owner, org, scim } = await ownerWithScim("Owner kept")
      // Provisioned as a member first, then promoted: a directory cannot link an existing account.
      const address = email()
      const created = await scim(
        "/Users",
        json({
          schemas: [SCIM_USER],
          userName: address,
          emails: [{ value: address, primary: true }],
          active: true,
        }),
      )
      expect(created.status).toBe(201)
      const { id: scimId } = (await created.json()) as { id: string }
      const [row] = await t.db
        .select({ id: member.id })
        .from(member)
        .innerJoin(userTable, eq(userTable.id, member.userId))
        .where(and(eq(userTable.email, address), eq(member.organizationId, org)))
      const promoted = await owner.b.request(
        "/api/auth/organization/update-member-role",
        json({ memberId: row?.id, role: "owner", organizationId: org }),
      )
      expect(promoted.status).toBe(200)
      expect(await memberOf(address, org)).toEqual({ role: "owner" })

      const off = await scim(
        `/Users/${scimId}`,
        json(
          { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] },
          "PATCH",
        ),
      )
      expect(off.status).toBe(200)
      expect(await memberOf(address, org)).toEqual({ role: "owner" })
      expect((await scim("/Users")).status).toBe(200)
    })

    it("lists the organization's tokens without secrets, and revoking one stops it at once", async () => {
      const { owner, token, connectionId, scim } = await ownerWithScim("Revoke")
      const listed = await owner.b.request("/v1/scim/tokens")
      expect(listed.status).toBe(200)
      const { tokens } = (await listed.json()) as { tokens: { id: string }[] }
      expect(tokens.map((x) => x.id)).toContain(connectionId)
      expect(JSON.stringify(tokens)).not.toContain(token)

      const revoked = await owner.b.request(`/v1/scim/tokens/${connectionId}`, { method: "DELETE" })
      expect(revoked.status).toBe(200)
      expect((await scim("/Users")).status).toBe(401)
      const after = await owner.b.request("/v1/scim/tokens")
      const { tokens: remaining } = (await after.json()) as { tokens: { id: string }[] }
      expect(remaining.map((x) => x.id)).not.toContain(connectionId)
    })

    it("another organization's token is NOT_FOUND to revoke", async () => {
      const { connectionId } = await ownerWithScim("Victim")
      const intruder = await signedUp("Intruder")
      const res = await intruder.b.request(`/v1/scim/tokens/${connectionId}`, { method: "DELETE" })
      expect(res.status).toBe(404)
    })

    it("demoting the creator below the owner role ends their token", async () => {
      const { owner, org, scim } = await ownerWithScim("Demoted")
      // Another owner makes the change: the sole owner cannot leave the organization without an owner.
      const heir = await signedUp("Demoted heir")
      await t.auth.api.addMember({
        body: { organizationId: org, userId: heir.userId, role: "owner" },
      })
      const [self] = await t.db
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.userId, owner.userId), eq(member.organizationId, org)))
      const demoted = await heir.b.request(
        "/api/auth/organization/update-member-role",
        json({ memberId: self?.id, role: "admin", organizationId: org }),
      )
      expect(demoted.status).toBe(200)
      expect((await scim("/Users")).status).toBe(401)
    })
  })

  describe("reserved organization slugs", () => {
    it("refuses a reserved slug on create and on update", async () => {
      const { b } = await signedUp("Owner")
      const explicit = await b.client.organization.create({ name: "Admin area", slug: "admin" })
      expect(explicit.error).toMatchObject({ status: 400, code: "RESERVED_ORGANIZATION_SLUG" })

      const hyphenated = await b.client.organization.create({
        name: "Two Factor",
        slug: "two-factor",
      })
      expect(hyphenated.error).toMatchObject({ status: 400, code: "RESERVED_ORGANIZATION_SLUG" })

      const { data: org, error } = await b.client.organization.create({
        name: "Fine",
        slug: `fine-${n}`,
      })
      expect(error).toBeNull()
      const renamed = await b.client.organization.update({
        organizationId: org?.id ?? "",
        data: { slug: "settings" },
      })
      expect(renamed.error).toMatchObject({ status: 400, code: "RESERVED_ORGANIZATION_SLUG" })
    })
  })

  describe("password breach check (Have I Been Pwned, faked)", () => {
    const BAD_PASSWORD = "Breached-Password-2026"
    const badHash = createHash("sha1").update(BAD_PASSWORD).digest("hex").toUpperCase()
    const realFetch = globalThis.fetch
    let checked = 0
    let t2: Awaited<ReturnType<typeof createTestApp>>

    beforeAll(async () => {
      t2 = await createTestApp([], { breachCheck: true })
      // The k-anonymity range API: only the matching suffix comes back. Everything else is clean.
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!url.startsWith("https://api.pwnedpasswords.com/range/")) return realFetch(input, init)
        checked++
        const prefix = url.split("/").pop()
        const body =
          prefix === badHash.slice(0, 5)
            ? `${badHash.slice(5)}:37\r\n0000000000000000000000000000000000000:0\r\n`
            : "0000000000000000000000000000000000000:0\r\n"
        return Promise.resolve(new Response(body, { status: 200 }))
      })
    })
    afterAll(async () => {
      vi.unstubAllGlobals()
      await t2.close()
    })

    it("refuses a breached password at sign-up, with the code the app maps", async () => {
      const b = browser((url, init) => t2.app.request(url, init))
      const { error } = await b.client.signUp.email({
        email: `breach-${++n}@example.com`,
        password: BAD_PASSWORD,
        name: "Ada",
      })
      expect(error).toMatchObject({
        status: 400,
        code: "PASSWORD_COMPROMISED",
        message: "This password has shown up in a known data breach. Choose a different one.",
      })
      expect(checked).toBeGreaterThan(0)
    })

    it("refuses a breached password when changing it, and accepts a clean one", async () => {
      const b = browser((url, init) => t2.app.request(url, init))
      await b.client.signUp.email({
        email: `breach-${++n}@example.com`,
        password: PASSWORD,
        name: "Ada",
      })
      const bad = await b.client.changePassword({
        currentPassword: PASSWORD,
        newPassword: BAD_PASSWORD,
      })
      expect(bad.error).toMatchObject({ code: "PASSWORD_COMPROMISED" })
      const good = await b.client.changePassword({
        currentPassword: PASSWORD,
        newPassword: "a-clean-passphrase",
      })
      expect(good.error).toBeNull()
    })
  })
  /** The first email with this subject to an address, once it has arrived. */
  const mailed = (to: string, subject: string) =>
    vi.waitFor(() => {
      const mail = inbox(to).find((m) => m.subject === subject)
      if (!mail) throw new Error(`waiting for "${subject}" to ${to}`)
      return mail
    })

  /** Enrol an authenticator on a signed-in browser; returns its secret and the backup codes. */
  async function enrolTwoFactor(b: ReturnType<typeof open>, password = PASSWORD) {
    const enrol = await b.client.twoFactor.enable({ password })
    const secret =
      new URL((enrol.data as { totpURI?: string } | null)?.totpURI ?? "").searchParams.get(
        "secret",
      ) ?? ""
    const backupCodes = (enrol.data as { backupCodes?: string[] } | null)?.backupCodes ?? []
    expect((await b.client.twoFactor.verifyTotp({ code: totp(secret) })).error).toBeNull()
    return { secret, backupCodes }
  }

  describe("change email", () => {
    const fresh = () => `moved-${++n}@example.com`
    const CONFIRM = "Confirm your new email address for Proof"
    const REQUESTED = "A new email address was requested for your Proof account"

    it("keeps the old address until the new one confirms, and tells the old one", async () => {
      const { b, email: oldAddress } = await signedUp("Ada")
      const next = fresh()
      expect((await b.client.changeEmail({ newEmail: next })).error).toBeNull()

      const confirm = await mailed(next, CONFIRM)
      expect(confirm.link).toMatch(/\/api\/auth\/verify-email\?token=/)
      await mailed(oldAddress, REQUESTED)
      expect((await b.client.getSession()).data?.user.email).toBe(oldAddress)
      expect(
        (await open().client.signIn.email({ email: oldAddress, password: PASSWORD })).error,
      ).toBeNull()

      const landed = await b.request(confirm.link)
      expect(landed.status).toBe(302)
      expect((await b.client.getSession()).data?.user.email).toBe(next)
      expect(
        (await open().client.signIn.email({ email: next, password: PASSWORD })).error,
      ).toBeNull()
      const gone = await open().client.signIn.email({ email: oldAddress, password: PASSWORD })
      expect(gone.error).toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" })
    })

    it("answers the same for an address that is taken, and sends the new address nothing", async () => {
      const { b, email: oldAddress } = await signedUp()
      const { email: taken } = await signedUp()
      expect((await b.client.changeEmail({ newEmail: taken })).error).toBeNull()
      expect(inbox(taken).some((m) => m.subject === CONFIRM)).toBe(false)
      expect((await b.client.getSession()).data?.user.email).toBe(oldAddress)
    })

    it("a link opened without the user's session changes nothing and signs no one in", async () => {
      const { b, email: oldAddress } = await signedUp("Ada")
      const next = fresh()
      await b.client.changeEmail({ newEmail: next })
      const confirm = await mailed(next, CONFIRM)

      const stranger = open()
      const landed = await stranger.request(confirm.link)
      expect(landed.status).toBe(302)
      const to = new URL(landed.headers.get("location") ?? "", BASE)
      expect(to.pathname).toBe("/sign-in")
      expect(to.searchParams.get("error")).toBe("SIGN_IN_TO_CONFIRM_EMAIL_CHANGE")
      // The sign-in page resumes the link after the person signs in.
      expect(new URL(to.searchParams.get("next") ?? "", BASE).pathname).toBe(
        "/api/auth/verify-email",
      )
      expect(landed.headers.getSetCookie()).toEqual([])
      expect(stranger.jar.size).toBe(0)
      expect((await stranger.client.getSession()).data).toBeNull()

      // Not verified: the new address can't sign in yet, the old one still can.
      const early = await open().client.signIn.email({ email: next, password: PASSWORD })
      expect(early.error).toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" })
      expect(
        (await open().client.signIn.email({ email: oldAddress, password: PASSWORD })).error,
      ).toBeNull()

      // Signed in as the owner, the same link now completes the change.
      await stranger.client.signIn.email({ email: oldAddress, password: PASSWORD })
      // The resumed link is the one mailed, callbackURL and all, so it lands where the mail sent it.
      const resumed = await stranger.request(to.searchParams.get("next") ?? "")
      expect(resumed.status).toBe(302)
      expect(resumed.headers.get("location")).toBe(
        new URL(confirm.link).searchParams.get("callbackURL"),
      )
      expect((await stranger.client.getSession()).data?.user.email).toBe(next)
    })

    it("refuses the link for another user's session, which stays as it was", async () => {
      const { b, email: oldAddress } = await signedUp("Ada")
      const other = await signedUp("Someone else")
      const next = fresh()
      await b.client.changeEmail({ newEmail: next })
      const confirm = await mailed(next, CONFIRM)

      const landed = await other.b.request(confirm.link)
      expect(landed.status).toBe(302)
      expect(new URL(landed.headers.get("location") ?? "", BASE).searchParams.get("error")).toBe(
        "SIGN_IN_TO_CONFIRM_EMAIL_CHANGE",
      )
      expect((await other.b.client.getSession()).data?.user.id).toBe(other.userId)
      expect((await b.client.getSession()).data?.user.email).toBe(oldAddress)

      // A refused link is not used up: the owner's own session can still complete it.
      await b.request(confirm.link)
      expect((await b.client.getSession()).data?.user.email).toBe(next)
    })

    it("resends by asking again: each request emails a fresh link to the new address", async () => {
      const { b } = await signedUp()
      const next = fresh()
      await b.client.changeEmail({ newEmail: next })
      await b.client.changeEmail({ newEmail: next })
      await delivered(next, 2)
      expect(inbox(next).filter((m) => m.subject === CONFIRM)).toHaveLength(2)
    })

    it("refuses the address the account already has, and tells no one", async () => {
      const { b, email } = await signedUp()
      const same = await b.client.changeEmail({ newEmail: email })
      expect(same.error).toMatchObject({ status: 400 })
      // The after-hook sees refused requests too; the old address must not be told about one.
      expect(inbox(email).some((m) => m.subject === REQUESTED)).toBe(false)
    })
  })

  describe("delete account", () => {
    const CONFIRM_DELETE = "Confirm deleting your Proof account"

    // The file sweep on deletion (file-sweep.ts): accounts with files, and what the store holds.
    // PNG is a real 1x1 image.
    const PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    const upload = async (b: ReturnType<typeof open>, path: string) => {
      const res = await b.request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: PNG }),
      })
      expect(res.status, path).toBe(200)
    }
    const keysUnder = (prefix: string) =>
      [...files.files.keys()].filter((k) => k.startsWith(prefix))
    const sweepsOf = (...prefixes: string[]) => sweeps.filter((s) => prefixes.includes(s.prefix))
    const activeOrg = async (b: ReturnType<typeof open>) =>
      (await b.client.getSession()).data?.session.activeOrganizationId ?? ""
    /** A new account with an avatar and a logo on its personal organization. */
    async function withFiles(name: string) {
      const account = await signedUp(name)
      const orgId = await activeOrg(account.b)
      await upload(account.b, "/v1/me/avatar")
      await upload(account.b, "/v1/organization/logo")
      const person = `user/${account.userId}/`
      const org = `org/${orgId}/`
      expect(keysUnder(person)).toHaveLength(1)
      expect(keysUnder(org)).toHaveLength(1)
      return { ...account, orgId, person, org }
    }

    it("refuses while the user owns an organization others use, and emails nothing", async () => {
      const { b, email: address } = await signedUp("Ada")
      const created = await b.client.organization.create({ name: "Acme Labs", slug: `acme-${++n}` })
      expect(created.error).toBeNull()

      const res = await b.client.deleteUser({ callbackURL: "/goodbye" })
      expect(res.error).toMatchObject({ status: 400, code: "OWNS_ORGANIZATION" })
      expect(res.error?.message).toBe("You own Acme Labs. Transfer or delete it first.")
      expect(inbox(address).some((m) => m.subject === CONFIRM_DELETE)).toBe(false)
      expect((await whoami(b)).status).toBe(200)
    })

    it("refuses while the personal organization has another member", async () => {
      const { b } = await signedUp("Ada")
      const other = await signedUp("Ben")
      const { data: session } = await b.client.getSession()
      await t.auth.api.addMember({
        body: {
          organizationId: session?.session.activeOrganizationId ?? "",
          userId: other.userId,
          role: "member",
        },
      })
      const res = await b.client.deleteUser({})
      expect(res.error).toMatchObject({ code: "OWNS_ORGANIZATION" })
      expect(res.error?.message).toBe("You own Ada's workspace. Transfer or delete it first.")
    })

    it("emails a confirmation first; the link removes the account, its sessions, passkeys and personal organization", async () => {
      const { b, email: address, userId } = await signedUp("Gone")
      const phone = open()
      await phone.client.signIn.email({ email: address, password: PASSWORD })
      const { data: session } = await b.client.getSession()
      const orgId = session?.session.activeOrganizationId ?? ""
      await t.db.insert(passkeyTable).values({
        id: `pk-del-${userId}`,
        name: "Key",
        publicKey: "cHVibGljLWtleQ",
        userId,
        credentialID: `cred-del-${userId}`,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        transports: "usb",
        createdAt: new Date(),
        aaguid: "00000000-0000-0000-0000-000000000000",
      })

      const asked = await b.client.deleteUser({ callbackURL: "/goodbye" })
      expect(asked.error).toBeNull()
      expect(asked.data).toMatchObject({ success: true, message: "Verification email sent" })
      expect((await whoami(b)).status).toBe(200)

      const confirm = await mailed(address, CONFIRM_DELETE)
      const landed = await b.request(confirm.link)
      expect(landed.status).toBe(302)
      expect(new URL(landed.headers.get("location") ?? "", BASE).pathname).toBe("/goodbye")

      expect(await whoami(b)).toMatchObject(SIGNED_OUT)
      expect(await whoami(phone)).toMatchObject(SIGNED_OUT)
      const back = await open().client.signIn.email({ email: address, password: PASSWORD })
      expect(back.error).toMatchObject({ status: 401 })

      const find = async (model: string, field: string, value: string) =>
        (await t.auth.$context).adapter.findOne({ model, where: [{ field, value }] })
      expect(await find("user", "id", userId)).toBeNull()
      expect(await find("account", "userId", userId)).toBeNull()
      expect(await find("member", "userId", userId)).toBeNull()
      expect(await find("passkey", "userId", userId)).toBeNull()
      expect(await find("organization", "id", orgId)).toBeNull()
      expect(await find("apikey", "referenceId", orgId)).toBeNull()
    })

    it("removes the personal organization's API keys with it", async () => {
      const { b, email, userId } = await signedUp("Keyed")
      const orgId = (await b.client.getSession()).data?.session.activeOrganizationId ?? ""
      await t.auth.api.createApiKey({
        body: { organizationId: orgId, userId, permissions: { project: ["read"] } },
      })
      const adapter = (await t.auth.$context).adapter
      const keysLeft = () =>
        adapter.count({ model: "apikey", where: [{ field: "referenceId", value: orgId }] })
      expect(await keysLeft()).toBe(1)

      expect((await b.client.deleteUser({})).error).toBeNull()
      const confirm = await mailed(email, CONFIRM_DELETE)
      await b.request(confirm.link)
      expect(await keysLeft()).toBe(0)
    })

    // The personal organization is deleted raw (no organization hooks), so removePersonalOrganization
    // runs entitlements' cleanup itself: the snapshot and the usage counters go with it.
    it("removes the personal organization's entitlements rows with it", async () => {
      const { b, email } = await signedUp("Metered")
      const orgId = (await b.client.getSession()).data?.session.activeOrganizationId ?? ""
      await t.auth.entitlements.get(orgId)
      await t.auth.entitlements.consumeUsage(orgId, "requests")
      const adapter = (await t.auth.$context).adapter
      const rows = async () => ({
        snapshots: await adapter.count({
          model: "entitlementSnapshot",
          where: [{ field: "organizationId", value: orgId }],
        }),
        usage: await adapter.count({
          model: "entitlementUsage",
          where: [{ field: "organizationId", value: orgId }],
        }),
      })
      expect(await rows()).toEqual({ snapshots: 1, usage: 1 })

      expect((await b.client.deleteUser({})).error).toBeNull()
      const confirm = await mailed(email, CONFIRM_DELETE)
      await b.request(confirm.link)
      expect(await rows()).toEqual({ snapshots: 0, usage: 0 })
    })

    it("never lets an organization pass for someone's personal one", async () => {
      const owner = await signedUp("Olga")
      const shared = await owner.b.client.organization.create({
        name: "Shared Co",
        slug: `shared-${++n}`,
      })
      const orgId = shared.data?.id ?? ""
      const { b: admin, email: address, userId } = await signedUp("Adam")
      await t.auth.api.addMember({ body: { organizationId: orgId, userId, role: "admin" } })
      const personalId = (await admin.client.getSession()).data?.session.activeOrganizationId ?? ""
      const personal = `personal-${userId.toLowerCase()}`

      // A personal slug is never chosen: not on create, and not by renaming (even once freed).
      expect(
        (
          await admin.client.organization.update({
            organizationId: personalId,
            data: { name: "Mine" },
          })
        ).error,
      ).toBeNull()
      const moved = await admin.client.organization.update({
        organizationId: personalId,
        data: { slug: `adam-${++n}` },
      })
      expect(moved.error).toBeNull()
      const renamed = await admin.client.organization.update({
        organizationId: orgId,
        data: { slug: personal },
      })
      expect(renamed.error).toMatchObject({ status: 400, code: "RESERVED_ORGANIZATION_SLUG" })
      const made = await admin.client.organization.create({
        name: "Fake",
        slug: `personal-x${++n}`,
      })
      expect(made.error).toMatchObject({ status: 400, code: "RESERVED_ORGANIZATION_SLUG" })

      // Even with the slug set some other way, deleting the account leaves an organization the
      // user doesn't own alone.
      expect(
        (await admin.client.organization.delete({ organizationId: personalId })).error,
      ).toBeNull()
      const adapter = (await t.auth.$context).adapter
      await adapter.updateMany({
        model: "organization",
        where: [{ field: "id", value: orgId }],
        update: { slug: personal },
      })
      expect((await admin.client.deleteUser({})).error).toBeNull()
      await admin.request((await mailed(address, CONFIRM_DELETE)).link)
      expect(
        await adapter.findOne({ model: "user", where: [{ field: "id", value: userId }] }),
      ).toBeNull()
      expect(
        await adapter.findOne({ model: "organization", where: [{ field: "id", value: orgId }] }),
      ).not.toBeNull()
    })

    describe("sweeps the deleted owner's files", () => {
      it("on self-delete: the avatar and the personal organization's logo, once both rows are gone", async () => {
        const { b, email: address, userId, orgId, person, org } = await withFiles("Swept")
        expect((await b.client.deleteUser({ callbackURL: "/goodbye" })).error).toBeNull()
        const landed = await b.request((await mailed(address, CONFIRM_DELETE)).link)
        expect(landed.status).toBe(302)

        expect(keysUnder(person)).toEqual([])
        expect(keysUnder(org)).toEqual([])
        expect(sweepsOf(person, org)).toEqual([
          { prefix: person, rowLeft: false },
          { prefix: org, rowLeft: false },
        ])
        const adapter = (await t.auth.$context).adapter
        expect(
          await adapter.findOne({ model: "user", where: [{ field: "id", value: userId }] }),
        ).toBeNull()
        expect(
          await adapter.findOne({ model: "organization", where: [{ field: "id", value: orgId }] }),
        ).toBeNull()
      })

      it("on organization delete: its logo, and no other organization's", async () => {
        const bystander = await withFiles("Bystander")
        const owner = await signedUp("Org sweeper")
        const created = await owner.b.client.organization.create({
          name: "Swept Co",
          slug: `swept-${++n}`,
        })
        const orgId = created.data?.id ?? ""
        expect(
          (await owner.b.client.organization.setActive({ organizationId: orgId })).error,
        ).toBeNull()
        await upload(owner.b, "/v1/organization/logo")
        const org = `org/${orgId}/`
        expect(keysUnder(org)).toHaveLength(1)

        expect(
          (await owner.b.client.organization.delete({ organizationId: orgId })).error,
        ).toBeNull()
        expect(keysUnder(org)).toEqual([])
        expect(sweepsOf(org)).toEqual([{ prefix: org, rowLeft: false }])
        expect(keysUnder(bystander.org)).toHaveLength(1)
        expect(keysUnder(bystander.person)).toHaveLength(1)
      })

      // Admin removal skips deleteUser.beforeDelete, so the personal organization (and its logo)
      // stays: a known gap (docs/roadmap.md). Only the person's own files go.
      it("on admin removal: the person's files only", async () => {
        const { b: root, userId: rootId } = await signedUp("Root sweeper")
        await (await t.auth.$context).adapter.updateMany({
          model: "user",
          where: [{ field: "id", value: rootId }],
          update: { role: "admin" },
        })
        const victim = await withFiles("Removed")

        expect((await root.client.admin.removeUser({ userId: victim.userId })).error).toBeNull()
        expect(keysUnder(victim.person)).toEqual([])
        expect(keysUnder(victim.org)).toHaveLength(1)
        expect(sweepsOf(victim.person, victim.org)).toEqual([
          { prefix: victim.person, rowLeft: false },
        ])
      })

      it("never fails the deletion when the store throws, and reports the error", async () => {
        const reported: { message: string; context: Record<string, unknown> }[] = []
        setErrorReporter((error, context) =>
          reported.push({ message: error.message, context: context ?? {} }),
        )
        failSweeps = true
        onTestFinished(() => {
          failSweeps = false
          setErrorReporter(undefined)
        })
        const { b, email: address, userId, person, org } = await withFiles("Unswept")
        expect((await b.client.deleteUser({ callbackURL: "/goodbye" })).error).toBeNull()
        const landed = await b.request((await mailed(address, CONFIRM_DELETE)).link)
        expect(landed.status).toBe(302)
        expect(new URL(landed.headers.get("location") ?? "", BASE).pathname).toBe("/goodbye")

        expect(
          await (await t.auth.$context).adapter.findOne({
            model: "user",
            where: [{ field: "id", value: userId }],
          }),
        ).toBeNull()
        expect(sweepsOf(person, org)).toEqual([
          { prefix: person, rowLeft: false },
          { prefix: org, rowLeft: false },
        ])
        const sweepErrors = reported.filter((r) => r.context.phase === "onDeleted")
        expect(sweepErrors).toHaveLength(2)
        expect(sweepErrors[0]?.context).toMatchObject({ userId })
        // The files stay: a failed sweep leaves orphans, never a failed deletion.
        expect(keysUnder(person)).toHaveLength(1)
      })

      it("sweeps nothing when the deletion request is refused", async () => {
        const { b, person, org } = await withFiles("Keeper")
        const shared = await b.client.organization.create({ name: "Kept Co", slug: `kept-${++n}` })
        expect(shared.error).toBeNull()

        const res = await b.client.deleteUser({})
        expect(res.error).toMatchObject({ code: "OWNS_ORGANIZATION" })
        expect(keysUnder(person)).toHaveLength(1)
        expect(keysUnder(org)).toHaveLength(1)
        expect(sweepsOf(person, org, `org/${shared.data?.id}/`)).toEqual([])
      })
    })

    it("re-checks when the link opens: an organization created since the request still refuses", async () => {
      const { b, email: address, userId, person, org } = await withFiles("Late")
      expect((await b.client.deleteUser({})).error).toBeNull()
      const confirm = await mailed(address, CONFIRM_DELETE)
      expect(
        (await b.client.organization.create({ name: "Late Co", slug: `late-${++n}` })).error,
      ).toBeNull()

      const landed = await b.request(confirm.link)
      expect(landed.status).toBe(400)
      expect(await landed.json()).toMatchObject({ code: "OWNS_ORGANIZATION" })
      expect((await whoami(b)).status).toBe(200)
      const user = await (await t.auth.$context).adapter.findOne({
        model: "user",
        where: [{ field: "id", value: userId }],
      })
      expect(user).not.toBeNull()
      // beforeDelete refused before it removed anything, so nothing is swept and the files stay.
      expect(sweepsOf(person, org)).toEqual([])
      expect(keysUnder(person)).toHaveLength(1)
      expect(keysUnder(org)).toHaveLength(1)
    })
  })

  describe("how a session was signed in", () => {
    it("records the method on the session a password sign-in creates", async () => {
      const { email: address } = await signedUp()
      const b = open()
      await b.client.signIn.email({ email: address, password: PASSWORD })
      const { data } = await b.client.getSession()
      expect(data?.session as unknown).toMatchObject({
        loginMethod: "email",
        loginTwoFactor: false,
      })
    })

    it("records the second factor once its code has been accepted", async () => {
      const { b, email: address } = await signedUp()
      const { secret } = await enrolTwoFactor(b)
      await b.client.signOut()

      const visitor = open()
      await visitor.client.signIn.email({ email: address, password: PASSWORD })
      expect((await visitor.client.twoFactor.verifyTotp({ code: totp(secret) })).error).toBeNull()
      const { data } = await visitor.client.getSession()
      expect(data?.session as unknown).toMatchObject({ loginMethod: "email", loginTwoFactor: true })
    })

    it("a link sign-in that needs a code records the link as the method, and the code", async () => {
      const { b, email: address } = await signedUp()
      const { secret } = await enrolTwoFactor(b)
      await b.client.signOut()

      const visitor = open()
      await visitor.client.signIn.magicLink({ email: address, callbackURL: "/" })
      const link = (await mailed(address, "Your sign-in link for Proof")).link
      await visitor.request(link)
      expect((await visitor.client.twoFactor.verifyTotp({ code: totp(secret) })).error).toBeNull()
      const { data } = await visitor.client.getSession()
      expect(data?.session as unknown).toMatchObject({
        loginMethod: "magic-link",
        loginTwoFactor: true,
      })
    })

    it("lists each session with its method, and revokes one by token", async () => {
      const { b: laptop, email: address } = await signedUp()
      const phone = open()
      await phone.client.signIn.email({ email: address, password: PASSWORD })

      const { data: sessions } = await laptop.client.listSessions()
      expect(sessions?.map((s) => (s as unknown as { loginMethod: string }).loginMethod)).toEqual([
        "email",
        "email",
      ])
      const current = (await laptop.client.getSession()).data?.session.token
      const other = sessions?.find((s) => s.token !== current)
      expect((await laptop.client.revokeSession({ token: other?.token ?? "" })).error).toBeNull()
      expect(await whoami(phone)).toMatchObject(SIGNED_OUT)
      expect((await whoami(laptop)).status).toBe(200)
    })
  })

  /** Make a session look `seconds` old: freshness is measured from its creation. */
  const ageSessions = async (userId: string, seconds: number) =>
    (await t.auth.$context).adapter.update({
      model: "session",
      where: [{ field: "userId", value: userId }],
      update: { createdAt: new Date(Date.now() - seconds * 1000) },
    })

  describe("fresh sessions for sensitive actions", () => {
    it("refuses a stale session's passkey registration and two-factor enrolment", async () => {
      const { b, userId } = await signedUp("Stale")
      await ageSessions(userId, 2 * 60 * 60)

      const passkeyOptions = await b.request("/api/auth/passkey/generate-register-options")
      expect(passkeyOptions.status).toBe(403)
      expect(await passkeyOptions.json()).toMatchObject({ code: "SESSION_NOT_FRESH" })

      const enrol = await b.request("/api/auth/two-factor/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      })
      expect(enrol.status).toBe(403)
      expect(await enrol.json()).toMatchObject({ code: "SESSION_NOT_FRESH" })
    })

    it("allows the same actions on a fresh sign-in", async () => {
      const { b, email: address, userId } = await signedUp("Fresh")
      await ageSessions(userId, 2 * 60 * 60)
      await b.client.signOut()

      const again = open()
      await again.client.signIn.email({ email: address, password: PASSWORD })
      const options = await again.request("/api/auth/passkey/generate-register-options")
      expect(options.status).toBe(200)
      const enrol = await again.request("/api/auth/two-factor/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      })
      expect(enrol.status).toBe(200)
    })
  })

  describe("auth events are audited", () => {
    /** The audit rows a person's auth activity wrote, in their personal organization. */
    const auditRowsOf = async (userId: string) => {
      const [personal] = await t.db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.slug, personalSlug(userId)))
        .limit(1)
      return t.db
        .select({ operation: auditEvent.operation, outcome: auditEvent.outcome })
        .from(auditEvent)
        .where(
          and(eq(auditEvent.organizationId, personal?.id ?? ""), eq(auditEvent.actorId, userId)),
        )
    }

    it("writes a sign-in, a failed sign-in and a sign-out to the personal organization", async () => {
      const { b, email: address, userId } = await signedUp("Audited")
      const visitor = open()
      const wrong = await visitor.client.signIn.email({
        email: address,
        password: "wrong-password",
      })
      expect(wrong.error).toBeTruthy()
      await visitor.client.signIn.email({ email: address, password: PASSWORD })
      await b.client.signOut()

      // Audit writes run after the response (auth-events.ts), so wait for them to land.
      const rows = await vi.waitFor(async () => {
        const found = await auditRowsOf(userId)
        expect(found).toEqual(
          expect.arrayContaining([
            { operation: "auth.sign_in", outcome: "ok" },
            { operation: "auth.sign_in_failed", outcome: expect.any(String) },
            { operation: "auth.sign_out", outcome: "ok" },
          ]),
        )
        return found
      })
      expect(rows.find((r) => r.operation === "auth.sign_in_failed")?.outcome).not.toBe("ok")
    })
  })

  describe("accepting an invitation is audited", () => {
    it("writes auth.invitation_accepted in the invited organization, not the personal one", async () => {
      const { b: owner } = await signedUp("Inviter")
      const { data: org } = await owner.client.organization.create({
        name: "Joined",
        slug: `joined-${n}`,
      })
      if (!org) throw new Error("no organization")
      const invitee = await signedUp("Invitee")
      const sent = await owner.client.organization.inviteMember({
        email: invitee.email,
        role: "member",
        organizationId: org.id,
      })
      const invitationId = sent.data?.id ?? ""
      const accepted = await invitee.b.client.organization.acceptInvitation({ invitationId })
      expect(accepted.error).toBeNull()

      // Audit writes run after the response (auth-events.ts), so wait for them to land.
      await vi.waitFor(async () => {
        const rows = await t.db
          .select({ operation: auditEvent.operation, outcome: auditEvent.outcome })
          .from(auditEvent)
          .where(and(eq(auditEvent.organizationId, org.id), eq(auditEvent.actorId, invitee.userId)))
        expect(rows).toContainEqual({ operation: "auth.invitation_accepted", outcome: "ok" })
      })
    })
  })

  describe("passkey sign-up (the mailbox is proven before any credential)", () => {
    const startSignUp = (b: ReturnType<typeof open>, address: string) =>
      b.request("/api/auth/passkey-signup/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, name: "Pat", callbackURL: "/welcome" }),
      })

    it("emails a link and issues no session; the link signs in a verified account", async () => {
      const address = email()
      const b = open()
      const start = await startSignUp(b, address)
      expect(start.status).toBe(200)
      expect(await start.json()).toEqual({ sent: true })
      expect(start.headers.getSetCookie()).toEqual([])
      expect(b.jar.size).toBe(0)

      const mail = await mailed(address, "Finish creating your Proof account")
      expect(mail.link).toContain("/api/auth/passkey-signup/verify?token=")

      const opened = await b.request(mail.link)
      expect(opened.status).toBe(302)
      expect(opened.headers.getSetCookie().length).toBeGreaterThan(0)
      // The row as the link wrote it, before getSession can refresh it: the configured lifetime (not
      // the one-day "don't remember me" one), started in the personal organization, and recorded as
      // an emailed-link sign-in.
      const [account] = await t.db
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.email, address))
      const [row] = await t.db
        .select()
        .from(sessionTable)
        .where(eq(sessionTable.userId, account?.id ?? ""))
      expect(row?.expiresAt.getTime() ?? 0).toBeGreaterThan(Date.now() + 2 * 24 * 60 * 60 * 1000)
      expect(row).toMatchObject({ loginMethod: "magic-link" })
      const [personal] = await t.db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.slug, personalSlug(account?.id ?? "")))
      expect(row?.activeOrganizationId).toBe(personal?.id)

      const { data } = await b.client.getSession()
      expect(data?.user).toMatchObject({ email: address, emailVerified: true })
    })

    it("refuses an email that already has an account", async () => {
      const { email: address } = await signedUp("Taken")
      const res = await startSignUp(open(), address)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: "ACCOUNT_EXISTS" })
    })

    it("refuses a link once it has been used, and one that was never issued", async () => {
      const address = email()
      const b = open()
      await startSignUp(b, address)
      const { link } = await mailed(address, "Finish creating your Proof account")
      expect((await b.request(link)).status).toBe(302)

      // A refused link goes to the sign-up page, which explains it, and sets no cookie.
      const replay = await open().request(link)
      expect(replay.status).toBe(302)
      expect(replay.headers.get("location")).toBe("/sign-up/passkey?error=PASSKEY_SIGNUP_EXPIRED")
      expect(replay.headers.getSetCookie()).toEqual([])

      const forged = await open().request(
        `/api/auth/passkey-signup/verify?token=${"A".repeat(43)}&callbackURL=%2F`,
      )
      expect(forged.status).toBe(302)
      expect(forged.headers.get("location")).toBe("/sign-up/passkey?error=PASSKEY_SIGNUP_EXPIRED")
      expect(forged.headers.getSetCookie()).toEqual([])
    })
  })

  describe("notifications (@byo-oss/notifications)", () => {
    it("lists a notification, marks it read and the unread count drops; another user can't see or mark it", async () => {
      const ada = await signedUp("Ada notices")
      const bob = await signedUp("Bob notices")
      const adaOrg = (await whoami(ada.b)).body.organizationId ?? ""
      // Seeding is setup, not the step under test: the server writes the row the way a feature would.
      const seeded = await t.auth.api.notify({
        body: {
          userId: ada.userId,
          organizationId: adaOrg,
          type: "approval.requested",
          title: "A run wants to send an email",
          href: "/runs",
        },
      })
      const id = seeded.notifications[0]?.id ?? ""
      expect(id).toBeTruthy()

      const listed = await ada.b.client.inbox.list({ query: { filter: "unread" } })
      expect(listed.error).toBeNull()
      expect(listed.data?.notifications).toEqual([
        expect.objectContaining({ id, userId: ada.userId, organizationId: adaOrg, read: false }),
      ])

      const before = await ada.b.client.inbox.unreadCount()
      expect(before.data?.count).toBe(1)

      const marked = await ada.b.client.inbox.markRead({ id })
      expect(marked.error).toBeNull()
      expect(marked.data?.notification).toMatchObject({ id, read: true })

      expect((await ada.b.client.inbox.unreadCount()).data?.count).toBe(0)
      expect(
        (await ada.b.client.inbox.list({ query: { filter: "unread" } })).data?.notifications,
      ).toEqual([])

      // Bob sees nothing of Ada's, and cannot mark Ada's row (NOT_FOUND, as for a missing row).
      expect((await bob.b.client.inbox.list()).data?.notifications).toEqual([])
      expect((await bob.b.client.inbox.unreadCount()).data?.count).toBe(0)
      const bobMark = await bob.b.client.inbox.markRead({ id })
      expect(bobMark.error).toMatchObject({ status: 404 })
      expect((await ada.b.client.inbox.unreadCount()).data?.count).toBe(0)
    })

    it("an impersonated session can read notifications but not mark them", async () => {
      const root = await signedUp("Root notices")
      const victim = await signedUp("Victim notices")
      const ctx = await t.auth.$context
      await ctx.adapter.updateMany({
        model: "user",
        where: [{ field: "id", value: root.userId }],
        update: { role: "admin" },
      })
      await t.auth.api.notify({
        body: { userId: victim.userId, type: "test.ping", title: "For the victim" },
      })
      expect(
        (await root.b.client.admin.impersonateUser({ userId: victim.userId })).error,
      ).toBeNull()

      const list = await root.b.request("/api/auth/inbox/list")
      expect(list.status).toBe(200)
      const id = ((await list.json()) as { notifications: { id: string }[] }).notifications[0]?.id
      expect(id).toBeTruthy()

      const mark = await root.b.request("/api/auth/inbox/mark-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      })
      expect(mark.status).toBe(403)
      expect(await mark.json()).toMatchObject({ code: "IMPERSONATED_SESSION_NOT_ALLOWED" })
    })
  })

  describe("security summary", () => {
    it("reports the password change, when two-factor went on, and the backup codes left", async () => {
      const { b, email: address } = await signedUp()
      const before = await b.client.securitySummary()
      expect(before.data).toMatchObject({
        twoFactorEnabled: false,
        twoFactorEnabledAt: null,
        backupCodesRemaining: null,
      })
      expect(before.data?.passwordChangedAt).toBeTruthy()

      const { backupCodes } = await enrolTwoFactor(b)
      const on = await b.client.securitySummary()
      expect(on.data?.twoFactorEnabled).toBe(true)
      expect(on.data?.twoFactorEnabledAt).toBeTruthy()
      expect(on.data?.backupCodesRemaining).toBe(backupCodes.length)

      await b.client.signOut()
      const visitor = open()
      await visitor.client.signIn.email({ email: address, password: PASSWORD })
      const used = backupCodes[0] ?? ""
      expect((await visitor.client.twoFactor.verifyBackupCode({ code: used })).error).toBeNull()
      expect((await visitor.client.securitySummary()).data?.backupCodesRemaining).toBe(
        backupCodes.length - 1,
      )
    })

    it("moves the password change time on a change, and clears two-factor's date when it goes off", async () => {
      const { b } = await signedUp()
      const first = (await b.client.securitySummary()).data?.passwordChangedAt
      await new Promise((r) => setTimeout(r, 20))
      expect(
        (
          await b.client.changePassword({
            currentPassword: PASSWORD,
            newPassword: "a-newer-passphrase",
          })
        ).error,
      ).toBeNull()
      const changed = (await b.client.securitySummary()).data?.passwordChangedAt
      expect(new Date(changed ?? 0).getTime()).toBeGreaterThan(new Date(first ?? 0).getTime())

      await enrolTwoFactor(b, "a-newer-passphrase")
      expect((await b.client.securitySummary()).data?.twoFactorEnabledAt).toBeTruthy()
      expect(
        (await b.client.twoFactor.disable({ password: "a-newer-passphrase" })).error,
      ).toBeNull()
      expect((await b.client.securitySummary()).data).toMatchObject({
        twoFactorEnabled: false,
        twoFactorEnabledAt: null,
        backupCodesRemaining: null,
      })
    })

    it("answers only a signed-in person", async () => {
      const res = await open().request("/api/auth/security/summary")
      expect(res.status).toBe(401)
    })
  })
})

describe("billing with Stripe test-mode keys set", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp([], {
      stripe: {
        secretKey: "sk_test_placeholder_for_tests", // gitleaks:allow
        webhookSecret: "whsec_placeholder_for_tests", // gitleaks:allow
        plans: [{ name: "pro", priceId: "price_placeholder_for_tests" }], // gitleaks:allow
      },
    })
  })
  afterAll(() => t.close())

  it("mounts the stripe webhook, which refuses an unsigned request", async () => {
    const res = await t.req("/api/auth/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).not.toBe(404)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  describe("who may manage an organization's subscription", () => {
    const open = () => browser((url, init) => t.app.request(url, init))
    const roles = ["owner", "admin", "member", "viewer"] as const
    const members: Record<(typeof roles)[number], ReturnType<typeof open>> = {
      owner: open(),
      admin: open(),
      member: open(),
      viewer: open(),
    }
    let org = ""

    beforeAll(async () => {
      const owner = members.owner
      const { data, error } = await owner.client.signUp.email({
        email: "billing-owner@example.com",
        password: PASSWORD,
        name: "Billing owner",
      })
      if (error || !data) throw new Error(`sign-up failed: ${JSON.stringify(error)}`)
      const res = await owner.request("/v1/whoami")
      org = ((await res.json()) as { organizationId?: string }).organizationId ?? ""
      for (const role of roles.filter((r) => r !== "owner")) {
        const { data: user, error: signUpError } = await members[role].client.signUp.email({
          email: `billing-${role}@example.com`,
          password: PASSWORD,
          name: `Billing ${role}`,
        })
        if (signUpError || !user) throw new Error(`sign-up failed: ${JSON.stringify(signUpError)}`)
        await t.auth.api.addMember({
          body: { organizationId: org, userId: user.user.id, role },
        })
      }
    })

    it.each(["owner", "admin"] as const)(
      "lets %s read and change the subscription",
      async (role) => {
        const res = await members[role].request(
          `/api/auth/subscription/list?customerType=organization&referenceId=${org}`,
        )
        expect(res.status).toBe(200)
      },
    )

    it.each(["member", "viewer"] as const)("refuses %s with 403", async (role) => {
      const res = await members[role].request(
        `/api/auth/subscription/list?customerType=organization&referenceId=${org}`,
      )
      expect(res.status).toBe(403)
    })
  })
})

describe("sign-in methods over HTTP", () => {
  it("lists the methods a server with no optional sign-in config offers, without a session", async () => {
    const t = await createTestApp()
    try {
      const res = await t.req("/api/auth/sign-in-methods")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        password: true,
        magicLink: true,
        passkey: true,
        social: [],
        sso: true,
        stripe: false,
      })
    } finally {
      await t.close()
    }
  })

  it("lists GitHub once its client id and secret are configured", async () => {
    const t = await createTestApp([], {
      github: { clientId: "gh-client", clientSecret: "gh-secret" }, // gitleaks:allow
    })
    try {
      const res = await t.req("/api/auth/sign-in-methods")
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ social: ["github"], password: true })
    } finally {
      await t.close()
    }
  })
})

describe("web app on another origin (WEB_ORIGINS)", () => {
  // The dev and e2e setup: vite serves the web app here, the API is at BASE.
  const WEB = "http://127.0.0.1:33195"
  let w: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    w = await createTestApp([], { webOrigins: [WEB] })
  })
  afterAll(() => w.close())

  const visitor = () => browser((url, init) => w.app.request(url, init))
  const mailTo = (address: string) =>
    vi.waitFor(() => {
      const mails = w.outbox.filter((m) => m.to === address)
      if (mails.length === 0) throw new Error(`waiting for an email to ${address}`)
      return mails
    })

  it("sends a magic link whose callbackURL is on a configured web origin", async () => {
    const { email: address } = await w.signUp("Ada")
    const { error } = await visitor().client.signIn.magicLink({
      email: address,
      callbackURL: `${WEB}/settings/agents`,
    })
    expect(error).toBeNull()
    await mailTo(address)
  })

  it("sends a password reset whose redirectTo is on a configured web origin", async () => {
    const { email: address } = await w.signUp("Grace")
    const { error } = await visitor().client.requestPasswordReset({
      email: address,
      redirectTo: `${WEB}/reset-password`,
    })
    expect(error).toBeNull()
    await mailTo(address)
  })

  it("still refuses a callbackURL on an origin that is not configured", async () => {
    const { email: address } = await w.signUp("Linus")
    const { error } = await visitor().client.signIn.magicLink({
      email: address,
      callbackURL: "http://127.0.0.1:9999/settings/agents",
    })
    expect(error).toMatchObject({ status: 403 })
    expect(w.outbox.filter((m) => m.to === address)).toHaveLength(0)
  })

  it("still refuses a reset redirectTo on an origin that is not configured", async () => {
    const { email: address } = await w.signUp("Ken")
    const { error } = await visitor().client.requestPasswordReset({
      email: address,
      redirectTo: "http://127.0.0.1:9999/reset-password",
    })
    expect(error).toMatchObject({ status: 403, code: "INVALID_REDIRECT_URL" })
    expect(w.outbox.filter((m) => m.to === address)).toHaveLength(0)
  })
})

describe("auth rate limit over HTTP (opted in, behind a trusted proxy)", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp([], { trustProxy: true, rateLimit: {} })
  })
  afterAll(() => t.close())

  /** A wrong-password sign-in from one client address (X-Forwarded-For, as a proxy sets it). */
  const signIn = (ip: string, extra: Record<string, string> = {}) =>
    t.req("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "x-forwarded-for": ip,
        ...extra,
      },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
    })

  it("answers 429 once one client address exceeds the sign-in limit", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await signIn("203.0.113.10")).status)
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(statuses[5]).toBe(429)
  })

  it("keeps a separate count for each client address", async () => {
    expect((await signIn("198.51.100.7")).status).toBe(401)
  })

  it("ignores a client-sent copy of the client-IP header: the proxy's address decides", async () => {
    // 203.0.113.10 is over its limit. Claiming another address in the header changes nothing.
    const spoofed = await signIn("203.0.113.10", { "x-proof-client-ip": "192.0.2.99" })
    expect(spoofed.status).toBe(429)
    // Nor does a spoofed header alone on a fresh address start a new bucket for the limited one.
    const other = await signIn("198.51.100.8", { "x-proof-client-ip": "203.0.113.10" })
    expect(other.status).toBe(401)
  })
})

// The notices the auth layer sends (packages/auth/src/notify-hooks.ts, index.ts): each event reaches
// the people it is about, and not the actor. Read through the recipient's own session, as the bell does.
describe("notices from the auth flows (@byo-oss/notifications)", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  const STRIPE_WEBHOOK_SECRET = "whsec_placeholder_for_tests" // gitleaks:allow
  beforeAll(async () => {
    t = await createTestApp([], {
      stripe: {
        secretKey: "sk_test_placeholder_for_tests", // gitleaks:allow
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        plans: [{ name: "pro", priceId: "price_placeholder_for_tests" }], // gitleaks:allow
      },
    })
  })
  afterAll(() => t.close())

  const open = () => browser((url, init) => t.app.request(url, init))
  let n = 0

  /** A signed-up person and their browser. */
  async function person(name: string) {
    const b = open()
    const email = `notice${++n}@example.com`
    const { data, error } = await b.client.signUp.email({ email, password: PASSWORD, name })
    if (error || !data) throw new Error(`sign-up failed: ${JSON.stringify(error)}`)
    return { b, email, userId: data.user.id }
  }

  /** Everything in a person's inbox, as the bell lists it (all organizations and personal notices). */
  const inboxOf = async (p: { b: ReturnType<typeof open> }) =>
    (await p.b.client.inbox.list({ query: { filter: "all", limit: 100 } })).data?.notifications ??
    []

  /**
   * An organization with an owner (the actor), an admin (a manager, so they hear of key and member
   * events) and a viewer (not a manager, so they hear of none of them).
   */
  async function team() {
    const owner = await person("Owner")
    const { data: org } = await owner.b.client.organization.create({
      name: `Team ${n}`,
      slug: `team-${n}`,
    })
    if (!org) throw new Error("no organization")
    const admin = await person("Admin")
    const viewer = await person("Viewer")
    await t.auth.api.addMember({
      body: { organizationId: org.id, userId: admin.userId, role: "admin" },
    })
    await t.auth.api.addMember({
      body: { organizationId: org.id, userId: viewer.userId, role: "viewer" },
    })
    const memberOf = async (userId: string) => {
      const { data } = await owner.b.client.organization.getFullOrganization({
        query: { organizationId: org.id },
      })
      return data?.members.find((m) => m.userId === userId)?.id ?? ""
    }
    return { org, owner, admin, viewer, memberOf }
  }

  const ofType = <R extends { type: string }>(rows: R[], type: string) =>
    rows.filter((r) => r.type === type)

  it("tells nobody when a person creates an organization (they are its only member)", async () => {
    const owner = await person("Creator")
    const { data: org } = await owner.b.client.organization.create({
      name: "Solo",
      slug: `solo-${n}`,
    })
    expect(org).toBeTruthy()
    expect(ofType(await inboxOf(owner), "member.joined")).toEqual([])
  })

  it("tells a person who already has an account that they were invited, with a link to accept", async () => {
    const { org, owner } = await team()
    const invitee = await person("Invitee")
    const invite = await owner.b.client.organization.inviteMember({
      email: invitee.email,
      role: "member",
      organizationId: org.id,
    })
    expect(invite.error).toBeNull()
    const invitationId = invite.data?.id ?? ""
    expect(ofType(await inboxOf(invitee), "invitation.received")).toEqual([
      expect.objectContaining({
        organizationId: null,
        title: "Invitation to join",
        body: `Owner invited you to join ${org.name}.`,
        href: `/accept-invitation/${invitationId}`,
      }),
    ])
    expect(ofType(await inboxOf(owner), "invitation.received")).toEqual([])
  })

  it("tells the managers when an invitee joins, and not the invitee or a viewer", async () => {
    const { org, owner, admin, viewer } = await team()
    const invitee = `joiner-${++n}@example.com`
    const invite = await owner.b.client.organization.inviteMember({
      email: invitee,
      role: "member",
      organizationId: org.id,
    })
    expect(invite.error).toBeNull()
    const [mail] = await vi.waitFor(() => {
      const found = t.outbox.filter((m) => m.to === invitee)
      if (found.length === 0) throw new Error("waiting for the invitation")
      return found
    })
    const invitationId = new URL(mail?.link ?? "").pathname.split("/").pop() ?? ""
    const joiner = open()
    await joiner.client.signUp.email({ email: invitee, password: PASSWORD, name: "Jo Joiner" })
    expect((await joiner.client.organization.acceptInvitation({ invitationId })).error).toBeNull()

    // The managers hear of everyone who joined after them (the admin and viewer were added above too).
    const aboutJo = (rows: { type: string; body?: string | null }[]) =>
      ofType(rows, "member.joined").filter((r) => r.body === `Jo Joiner joined ${org.name}.`)
    expect(aboutJo(await inboxOf(owner))).toEqual([
      expect.objectContaining({ organizationId: org.id, title: "New member", read: false }),
    ])
    expect(aboutJo(await inboxOf(admin))).toHaveLength(1)
    expect(aboutJo(await inboxOf(viewer))).toEqual([])
    expect(ofType(await inboxOf({ b: joiner }), "member.joined")).toEqual([])
    expect(ofType(await inboxOf(viewer), "member.joined")).toEqual([])
  })

  it("tells a member their new role, not the person who changed it", async () => {
    const { org, owner, viewer, memberOf } = await team()
    const updated = await owner.b.client.organization.updateMemberRole({
      memberId: await memberOf(viewer.userId),
      role: "admin",
      organizationId: org.id,
    })
    expect(updated.error).toBeNull()

    const toViewer = ofType(await inboxOf(viewer), "member.role_changed")
    expect(toViewer).toEqual([
      expect.objectContaining({
        organizationId: org.id,
        title: "Your role changed",
        href: expect.stringMatching(/^\//),
      }),
    ])
    expect(toViewer[0]?.body).toMatch(/^You're now admin in Team /)

    // Changing your own role is not news to you.
    const self = await owner.b.client.organization.updateMemberRole({
      memberId: await memberOf(owner.userId),
      role: "owner",
      organizationId: org.id,
    })
    expect(self.error).toBeNull()
    expect(ofType(await inboxOf(owner), "member.role_changed")).toEqual([])
  })

  it("tells a removed person (no link into the organization) and drops their notices for it", async () => {
    const { org, owner, viewer, memberOf } = await team()
    // A notice the viewer holds for this organization: the role change they hear about first.
    await owner.b.client.organization.updateMemberRole({
      memberId: await memberOf(viewer.userId),
      role: "admin",
      organizationId: org.id,
    })
    expect(
      (await inboxOf(viewer)).filter((r) => r.organizationId === org.id).length,
    ).toBeGreaterThan(0)

    const removed = await owner.b.client.organization.removeMember({
      memberIdOrEmail: await memberOf(viewer.userId),
      organizationId: org.id,
    })
    expect(removed.error).toBeNull()

    const rows = await inboxOf(viewer)
    expect(rows.filter((r) => r.organizationId === org.id)).toEqual([])
    expect(ofType(rows, "member.removed")).toEqual([
      expect.objectContaining({
        organizationId: null,
        title: "Access removed",
        body: `You were removed from ${org.name} and no longer have access to it.`,
      }),
    ])
    expect(ofType(await inboxOf(owner), "member.removed")).toEqual([])
  })

  it("a member who leaves keeps no notices for the organization, and gets no removal notice", async () => {
    const { org, owner, viewer, memberOf } = await team()
    await owner.b.client.organization.updateMemberRole({
      memberId: await memberOf(viewer.userId),
      role: "admin",
      organizationId: org.id,
    })
    const left = await viewer.b.client.organization.leave({ organizationId: org.id })
    expect(left.error).toBeNull()

    const rows = await inboxOf(viewer)
    expect(rows.filter((r) => r.organizationId === org.id)).toEqual([])
    expect(ofType(rows, "member.removed")).toEqual([])
  })

  it("a person who removes themselves is not told they were removed", async () => {
    const { org, owner, admin, memberOf } = await team()
    const removed = await admin.b.client.organization.removeMember({
      memberIdOrEmail: await memberOf(admin.userId),
      organizationId: org.id,
    })
    expect(removed.error).toBeNull()
    expect(ofType(await inboxOf(admin), "member.removed")).toEqual([])
    expect(ofType(await inboxOf(owner), "member.removed")).toEqual([])
  })

  it("tells the managers when a key is created, not the person who made it", async () => {
    const { org, owner, admin, viewer } = await team()
    const created = await owner.b.request("/api/auth/api-key/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Build bot", organizationId: org.id }),
    })
    expect(created.status).toBe(200)

    const toAdmin = ofType(await inboxOf(admin), "api_key.created")
    expect(toAdmin).toEqual([
      expect.objectContaining({
        organizationId: org.id,
        title: "API key created",
        body: `Build bot can act in ${org.name} with the permissions it was given.`,
      }),
    ])
    expect(ofType(await inboxOf(owner), "api_key.created")).toEqual([])
    expect(ofType(await inboxOf(viewer), "api_key.created")).toEqual([])
  })

  it("tells the managers when a key is deleted, and not the person who deleted it", async () => {
    const { org, owner, admin, viewer } = await team()
    const created = await owner.b.request("/api/auth/api-key/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Old bot", organizationId: org.id }),
    })
    const keyId = ((await created.json()) as { id: string }).id
    const deleted = await owner.b.request("/api/auth/api-key/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyId }),
    })
    expect(deleted.status).toBe(200)

    expect(ofType(await inboxOf(admin), "api_key.revoked")).toEqual([
      expect.objectContaining({
        organizationId: org.id,
        title: "API key revoked",
        body: `Old bot can no longer act in ${org.name}.`,
      }),
    ])
    expect(ofType(await inboxOf(owner), "api_key.revoked")).toEqual([])
    expect(ofType(await inboxOf(viewer), "api_key.revoked")).toEqual([])
  })

  it("tells the person whose password changed, and nobody else", async () => {
    const changer = await person("Changer")
    const other = await person("Other")
    const changed = await changer.b.client.changePassword({
      currentPassword: PASSWORD,
      newPassword: "a-new-passphrase",
    })
    expect(changed.error).toBeNull()

    expect(ofType(await inboxOf(changer), "account.password_changed")).toEqual([
      expect.objectContaining({
        organizationId: null,
        title: "Password changed",
        href: "/account/security",
      }),
    ])
    expect(ofType(await inboxOf(other), "account.password_changed")).toEqual([])
  })

  it("tells the person when two-factor is switched on and when it is switched off", async () => {
    const { b } = await person("Factor")
    const other = await person("Bystander")
    const enabling = await b.client.twoFactor.enable({ password: PASSWORD })
    const secret =
      new URL((enabling.data as { totpURI?: string } | null)?.totpURI ?? "").searchParams.get(
        "secret",
      ) ?? ""
    expect((await b.client.twoFactor.verifyTotp({ code: totp(secret) })).error).toBeNull()
    expect(ofType(await inboxOf({ b }), "account.two_factor_enabled")).toHaveLength(1)

    expect((await b.client.twoFactor.disable({ password: PASSWORD })).error).toBeNull()
    expect(ofType(await inboxOf({ b }), "account.two_factor_disabled")).toHaveLength(1)
    expect(ofType(await inboxOf(other), "account.two_factor_enabled")).toEqual([])
  })

  it("tells the person once their sign-in email has changed", async () => {
    const { b } = await person("Mover")
    const other = await person("Stayer")
    const next = `moved-notice-${++n}@example.com`
    expect((await b.client.changeEmail({ newEmail: next })).error).toBeNull()
    const confirm = await vi.waitFor(() => {
      const mail = t.outbox.find((m) => m.to === next)
      if (!mail) throw new Error("waiting for the confirmation")
      return mail
    })
    expect((await b.request(confirm.link)).status).toBe(302)

    expect(ofType(await inboxOf({ b }), "account.email_changed")).toEqual([
      expect.objectContaining({ organizationId: null, title: "Sign-in email changed" }),
    ])
    expect(ofType(await inboxOf(other), "account.email_changed")).toEqual([])
  })

  describe("the email-changed notice, verified or not", () => {
    /** The verification link mailed to an address, once it has arrived. */
    const linkTo = (address: string) =>
      vi.waitFor(() => {
        const mail = t.outbox.find((m) => m.to === address && m.link?.includes("/verify-email"))
        if (!mail?.link) throw new Error(`waiting for the link to ${address}`)
        return mail.link
      })
    const verified = async (p: { b: ReturnType<typeof open> }) =>
      (await p.b.client.getSession({ query: { disableCookieCache: true } })).data?.user
        .emailVerified
    /** A change-of-email token as better-auth signs one, with these claims and expiry. */
    const changeToken = (
      claims: { email: string; updateTo: string; userId: string },
      opts: { secret: string; exp: number },
    ) =>
      new SignJWT({ ...claims, requestType: "change-email-verification" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(opts.exp - 3600)
        .setExpirationTime(opts.exp)
        .sign(new TextEncoder().encode(opts.secret))

    it("a verified account gets exactly one, and its new address stays verified", async () => {
      const p = await person("Verified mover")
      expect((await p.b.client.sendVerificationEmail({ email: p.email })).error).toBeNull()
      expect([200, 302]).toContain((await p.b.request(await linkTo(p.email))).status)
      expect(await verified(p)).toBe(true)

      const next = `moved-verified-${++n}@example.com`
      expect((await p.b.client.changeEmail({ newEmail: next })).error).toBeNull()
      const link = await linkTo(next)
      expect((await p.b.request(link)).status).toBe(302)
      // Opening the used link again changes nothing and tells no one again: the session's address is
      // the new one now, so the link sends the person to sign in with the old one.
      const reopened = await p.b.request(link)
      expect(reopened.status).toBe(302)
      expect(new URL(reopened.headers.get("location") ?? "", BASE).searchParams.get("error")).toBe(
        "SIGN_IN_TO_CONFIRM_EMAIL_CHANGE",
      )

      expect((await p.b.client.getSession()).data?.user.email).toBe(next)
      expect(await verified(p)).toBe(true)
      expect(ofType(await inboxOf(p), "account.email_changed")).toHaveLength(1)
    })

    it("an unverified account gets one too, and stays unverified", async () => {
      const p = await person("Unverified mover")
      const next = `moved-unverified-${++n}@example.com`
      expect((await p.b.client.changeEmail({ newEmail: next })).error).toBeNull()
      expect((await p.b.request(await linkTo(next))).status).toBe(302)

      expect((await p.b.client.getSession()).data?.user.email).toBe(next)
      expect(await verified(p)).toBe(false)
      expect(ofType(await inboxOf(p), "account.email_changed")).toHaveLength(1)
    })

    it("an expired or forged change token changes nothing and sends no notice", async () => {
      const p = await person("Stays put")
      const now = Math.floor(Date.now() / 1000)
      const claims = { email: p.email, updateTo: `never-${++n}@example.com`, userId: p.userId }
      for (const token of [
        await changeToken(claims, { secret: SECRET, exp: now - 60 }),
        await changeToken(claims, {
          secret: "not-the-server-secret-but-long-enough",
          exp: now + 600,
        }),
      ]) {
        const res = await p.b.request(`/api/auth/verify-email?token=${token}`)
        expect(res.status).toBe(401)
      }

      expect((await p.b.client.getSession()).data?.user.email).toBe(p.email)
      expect(ofType(await inboxOf(p), "account.email_changed")).toEqual([])
    })

    it("a link opened without its callbackURL (a JSON answer) tells them too", async () => {
      const p = await person("API mover")
      const next = `moved-json-${++n}@example.com`
      expect((await p.b.client.changeEmail({ newEmail: next })).error).toBeNull()
      const link = new URL(await linkTo(next))
      link.searchParams.delete("callbackURL")
      const res = await p.b.request(`${link.pathname}${link.search}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: true })

      expect((await p.b.client.getSession()).data?.user.email).toBe(next)
      expect(ofType(await inboxOf(p), "account.email_changed")).toHaveLength(1)
    })

    it("a used link opened by whoever now holds the old address is refused, and tells no one again", async () => {
      const a = await person("Moved on")
      const next = `moved-on-${++n}@example.com`
      expect((await a.b.client.changeEmail({ newEmail: next })).error).toBeNull()
      const link = await linkTo(next)
      expect((await a.b.request(link)).status).toBe(302)
      expect(ofType(await inboxOf(a), "account.email_changed")).toHaveLength(1)

      // Someone else signs up with the released address and opens A's link while signed in.
      const b = open()
      expect(
        (await b.client.signUp.email({ email: a.email, password: PASSWORD, name: "Newcomer" }))
          .error,
      ).toBeNull()
      const refused = await b.request(link)
      expect(refused.status).toBe(302)
      expect(new URL(refused.headers.get("location") ?? "", BASE).searchParams.get("error")).toBe(
        "INVALID_TOKEN",
      )

      expect((await b.client.getSession()).data?.user.email).toBe(a.email)
      expect((await a.b.client.getSession()).data?.user.email).toBe(next)
      expect(ofType(await inboxOf(a), "account.email_changed")).toHaveLength(1)
    })

    it("a token not signed with the server's secret tells no one, even when its claims match an account", async () => {
      const a = await person("Target")
      const b = await person("Forger")
      const now = Math.floor(Date.now() / 1000)
      // B's own address as the old one (so B's session passes the before hook), A's as the new one.
      const token = await changeToken(
        { email: b.email, updateTo: a.email, userId: a.userId },
        { secret: "not-the-server-secret-but-long-enough", exp: now + 600 },
      )
      expect((await b.b.request(`/api/auth/verify-email?token=${token}`)).status).toBe(401)

      expect(ofType(await inboxOf(a), "account.email_changed")).toEqual([])
      expect(ofType(await inboxOf(b), "account.email_changed")).toEqual([])
    })

    it("a notifier that fails doesn't fail a completed change", async () => {
      const p = await person("Unlucky mover")
      const next = `moved-unlucky-${++n}@example.com`
      expect((await p.b.client.changeEmail({ newEmail: next })).error).toBeNull()
      const link = await linkTo(next)
      const spy = vi.spyOn(t.auth.api, "notify").mockRejectedValue(new Error("inbox down"))
      try {
        expect((await p.b.request(link)).status).toBe(302)
      } finally {
        spy.mockRestore()
      }
      expect((await p.b.client.getSession()).data?.user.email).toBe(next)
    })

    it("verifying a sign-up's address sends no notice", async () => {
      const p = await person("Just verifying")
      expect((await p.b.client.sendVerificationEmail({ email: p.email })).error).toBeNull()
      expect([200, 302]).toContain((await p.b.request(await linkTo(p.email))).status)

      expect(await verified(p)).toBe(true)
      expect(ofType(await inboxOf(p), "account.email_changed")).toEqual([])
    })
  })

  it("tells the organization's billing managers when a payment fails, and nobody else", async () => {
    const { org, owner, viewer } = await team()
    const customer = `cus_notice_${++n}`
    await t.auth.$context.then((ctx) =>
      ctx.adapter.updateMany({
        model: "organization",
        where: [{ field: "id", value: org.id }],
        update: { stripeCustomerId: customer },
      }),
    )
    const payload = JSON.stringify({
      id: `evt_notice_${n}`,
      object: "event",
      type: "invoice.payment_failed",
      data: { object: { id: `in_${n}`, object: "invoice", customer } },
    })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = createHmac("sha256", STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${payload}`)
      .digest("hex")
    const res = await t.req("/api/auth/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      },
      body: payload,
    })
    expect(res.status).toBe(200)

    expect(ofType(await inboxOf(owner), "billing.payment_failed")).toEqual([
      expect.objectContaining({
        organizationId: org.id,
        title: "Payment failed",
        href: expect.stringMatching(/\/settings\/billing$/),
      }),
    ])
    expect(ofType(await inboxOf(viewer), "billing.payment_failed")).toEqual([])
  })

  it("tells the billing managers when a subscription ends", async () => {
    const { org, owner, viewer } = await team()
    const customer = `cus_ended_${++n}`
    await t.auth.$context.then((ctx) =>
      ctx.adapter.updateMany({
        model: "organization",
        where: [{ field: "id", value: org.id }],
        update: { stripeCustomerId: customer },
      }),
    )
    const payload = JSON.stringify({
      id: `evt_ended_${n}`,
      object: "event",
      type: "customer.subscription.deleted",
      data: { object: { id: `sub_${n}`, object: "subscription", customer, status: "canceled" } },
    })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = createHmac("sha256", STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${payload}`)
      .digest("hex")
    const res = await t.req("/api/auth/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      },
      body: payload,
    })
    expect(res.status).toBe(200)

    expect(ofType(await inboxOf(owner), "billing.subscription_canceled")).toEqual([
      expect.objectContaining({ organizationId: org.id, title: "Subscription canceled" }),
    ])
    expect(ofType(await inboxOf(viewer), "billing.subscription_canceled")).toEqual([])
  })

  it("a notice that fails to send does not fail the change it is about", async () => {
    const changer = await person("Resilient")
    const spy = vi.spyOn(t.auth.api, "notify").mockRejectedValue(new Error("the inbox is down"))
    try {
      const changed = await changer.b.client.changePassword({
        currentPassword: PASSWORD,
        newPassword: "yet-another-passphrase",
      })
      expect(changed.error).toBeNull()
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
    // The change took effect: the new password signs in.
    const again = await open().client.signIn.email({
      email: changer.email,
      password: "yet-another-passphrase",
    })
    expect(again.error).toBeNull()
  })
})

describe("client ID metadata documents (CIMD) over HTTP", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  const open = () => browser((url, init) => t.app.request(url, init))
  /** Metadata documents the stub transport serves, by URL. Anything else is a 404. */
  const served = new Map<string, unknown>()
  /** The URLs the server asked for: a request that is refused before fetching never appears. */
  const fetched: string[] = []
  const stubFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    fetched.push(url)
    const doc = served.get(url)
    if (doc === undefined) return new Response("not found", { status: 404 })
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  beforeAll(async () => {
    t = await createTestApp([], { clientMetadataFetch: stubFetch })
  })
  afterAll(() => t.close())

  /** An authorization request whose client_id is a metadata document URL, as an MCP client sends. */
  const authorize = (clientId: string) =>
    t.req(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: "openid offline_access read",
        state: "s1",
        code_challenge: createHash("sha256").update("verifier").digest("base64url"),
        code_challenge_method: "S256",
        resource: MCP,
      })}`,
      { redirect: "manual" } as RequestInit,
    )

  /** The OAuth error an authorization answers with: in the redirect, or in a JSON body. */
  const refusal = async (res: Response): Promise<{ error?: string; description?: string }> => {
    if (res.status === 302) {
      const location = new URL(res.headers.get("location") ?? "", BASE)
      return {
        error: location.searchParams.get("error") ?? undefined,
        description: location.searchParams.get("error_description") ?? undefined,
      }
    }
    const body = (await res.json()) as { error?: string; error_description?: string }
    return { error: body.error, description: body.error_description }
  }

  it("advertises client_id_metadata_document_supported and keeps dynamic registration", async () => {
    const res = await t.req("/.well-known/oauth-authorization-server/api/auth")
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta.client_id_metadata_document_supported).toBe(true)
    expect(meta.registration_endpoint).toBe(`${BASE}/api/auth/oauth2/register`)
  })

  it("refuses a client_id URL that is not HTTPS, without fetching it", async () => {
    expect(await refusal(await authorize("http://client.example.com/metadata.json"))).toMatchObject(
      {
        error: "invalid_client",
      },
    )
  })

  it("refuses a client_id URL on a private or loopback address before fetching it", async () => {
    for (const url of ["https://127.0.0.1/metadata.json", "https://10.0.0.5/metadata.json"]) {
      expect(await refusal(await authorize(url))).toMatchObject({
        error: "invalid_client",
        description: "client_id URL must not target a private or reserved address",
      })
    }
  })

  it("accepts an HTTPS client_id whose metadata document is fetched and matches it", async () => {
    const clientId = "https://client.example/metadata.json"
    served.set(clientId, {
      client_id: clientId,
      client_name: "Agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    })
    const res = await authorize(clientId)
    expect(fetched).toContain(clientId)
    expect(res.status).toBe(302)
    // No session yet, so the authorization goes on to sign-in: it was accepted, not refused.
    expect(new URL(res.headers.get("location") ?? "", BASE).pathname).toBe("/sign-in")
  })

  it("refuses an HTTPS client_id whose metadata document names a different client_id", async () => {
    const clientId = "https://client.example/mismatch.json"
    served.set(clientId, {
      client_id: "https://client.example/someone-else.json",
      client_name: "Agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    })
    const res = await authorize(clientId)
    expect(fetched).toContain(clientId)
    expect(await refusal(res)).toMatchObject({
      error: "invalid_client",
      description: expect.stringMatching(/does not match/),
    })
  })

  it("runs the whole journey for a metadata-document client: sign-in to revoke", async () => {
    const CLIENT = "https://client.example/journey.json"
    served.set(CLIENT, {
      client_id: CLIENT,
      client_name: "Journey agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    })
    const address = `cimd-journey-${Date.now()}@example.com`
    const signup = await open().client.signUp.email({
      email: address,
      password: PASSWORD,
      name: "Journey",
    })
    expect(signup.error).toBeNull()
    const orgId = await (async () => {
      const b = open()
      await b.client.signIn.email({ email: address, password: PASSWORD })
      return ((await (await b.request("/v1/whoami")).json()) as { organizationId: string })
        .organizationId
    })()

    const verifier = b64(randomBytes(32))
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope: "openid offline_access read write admin",
      state: "journey",
      code_challenge: b64(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      resource: MCP,
    })

    // Sign in: the authorization goes to sign-in first, and the password sign-in resumes it.
    const c = open()
    const toLogin = await c.request(`/api/auth/oauth2/authorize?${query}`)
    const login = new URL(toLogin.headers.get("location") ?? "", BASE)
    expect(login.pathname).toBe("/sign-in")
    const oauthQuery = signedQuery(login.search)
    const signIn = await c.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: address, password: PASSWORD, oauth_query: oauthQuery }),
    })
    expect(signIn.status).toBe(200)
    expect((await c.request("/v1/whoami")).status).toBe(200)

    // Select organization: with no valid active org, the authorization goes to the picker first.
    await c.request("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: null }),
    })
    const picker = new URL(
      (await c.request(`/api/auth/oauth2/authorize?${query}`)).headers.get("location") ?? "",
      BASE,
    )
    expect(picker.pathname).toBe("/select-organization")
    await c.request("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: orgId }),
    })
    const cont = await c.request("/api/auth/oauth2/continue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postLogin: true, oauth_query: picker.search.slice(1) }),
    })
    const consentPage = new URL(((await cont.json()) as { url: string }).url, BASE)
    expect(consentPage.pathname).toBe("/consent")

    // Consent, then the token exchange with PKCE and the resource.
    const consent = await c.request("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
    })
    const code = new URL(((await consent.json()) as { url: string }).url).searchParams.get("code")
    expect(code).toBeTruthy()
    const exchange = await t.req("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT,
        client_id: CLIENT,
        code_verifier: verifier,
        resource: MCP,
      }),
    })
    const tokens = (await exchange.json()) as { access_token: string; refresh_token: string }
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token).toBeTruthy()
    const auth = bearer(tokens.access_token)

    // MCP: the tool list works, and a call acts in the chosen organization.
    const mcp = await t.mcpClient(auth)
    try {
      const { tools } = await mcp.listTools()
      expect(tools.map((tool) => tool.name)).toContain("list_connected_agents")
      const who = await mcp.callTool({ name: "whoami", arguments: {} })
      expect(who.isError ?? false).toBe(false)
      expect(JSON.stringify(who)).toContain(orgId)
    } finally {
      await mcp.close()
    }

    // REST: the connected agent is listed under its client id, then revoked by that id.
    const listed = await t.req("/v1/agents", { headers: auth })
    expect(listed.status).toBe(200)
    const { agents } = (await listed.json()) as {
      agents: { id: string; clientId: string | null }[]
    }
    const agent = agents.find((a) => a.clientId === CLIENT)
    expect(agent?.id).toBe(`client_${CLIENT}`)
    const revoked = await t.req(`/v1/agents/${encodeURIComponent(agent?.id ?? "")}`, {
      method: "DELETE",
      headers: auth,
    })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ revoked: true })

    // Revoked: the refresh token is refused, and so is the access token it held.
    const refreshed = await t.req("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: CLIENT,
        resource: MCP,
      }),
    })
    expect(refreshed.status).toBe(400)
    expect(((await refreshed.json()) as { error: string }).error).toBe("invalid_grant")
    expect((await t.req("/v1/whoami", { headers: auth })).status).toBe(401)
  })
})

/** The signed query the sign-in page sends back (as the web app's client builds it). */
function signedQuery(search: string): string {
  const params = new URLSearchParams(search)
  const names = new Set(params.getAll("ba_param"))
  const out = new URLSearchParams()
  for (const [k, v] of params) if (k === "sig" || k === "ba_param" || names.has(k)) out.append(k, v)
  return out.toString()
}
const b64 = (buf: Buffer) => buf.toString("base64url")
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
