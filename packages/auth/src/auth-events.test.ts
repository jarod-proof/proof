import { createTestDb } from "@proof/db/testing"
import { type AppError, setErrorReporter } from "@proof/errors"
import { APIError } from "better-auth/api"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AUDIENCE, BASE } from "./auth.test.helpers"
import {
  AUTH_EVENT_NAMES,
  AUTH_EVENT_PATHS,
  type AuthCallContext,
  type AuthEvent,
  type AuthSession,
  authEvents,
  drainAuthEvents,
  errorCodeOf,
  mapAuthEvent,
} from "./auth-events"
import { createAuth } from "./index"

const session = (userId: string, activeOrganizationId: string | null = null): AuthSession => ({
  user: { id: userId },
  session: { activeOrganizationId },
})

const call = (path: string, over: Partial<AuthCallContext> = {}): AuthCallContext => ({
  path,
  findUserIdByEmail: async () => null,
  ...over,
})

const refused = (code: string) => APIError.from("BAD_REQUEST", { code, message: code })

describe("mapAuthEvent", () => {
  it("records a successful sign-in with the new session's user and no organization", async () => {
    const event = await mapAuthEvent(
      call("/sign-in/email", {
        newSession: session("u_ann"),
        returned: { user: { id: "u_ann" }, token: "t" },
        ip: "203.0.113.4",
      }),
    )
    expect(event).toEqual({
      name: "auth.sign_in",
      userId: "u_ann",
      organizationId: null,
      outcome: "ok",
      ip: "203.0.113.4",
      path: "/sign-in/email",
    })
  })

  it("records the sign-in when the second factor completes it, not the factor step itself", async () => {
    expect(
      await mapAuthEvent(
        call("/two-factor/verify-totp", { newSession: session("u_ann"), returned: {} }),
      ),
    ).toMatchObject({ name: "auth.sign_in", userId: "u_ann" })
    // A wrong code names no account (the pending factor isn't in the session): logged, not stored.
    expect(
      await mapAuthEvent(call("/two-factor/verify-totp", { returned: refused("INVALID_CODE") })),
    ).toMatchObject({ name: "auth.sign_in_failed", userId: null, outcome: "INVALID_CODE" })
  })

  it("records nothing for a password sign-in that still needs a second factor", async () => {
    const event = await mapAuthEvent(
      call("/sign-in/email", { returned: { twoFactorRedirect: true }, body: { email: "a@x.io" } }),
    )
    expect(event).toBeNull()
  })

  it("records a failed sign-in for a known email as that user, with the error code", async () => {
    const event = await mapAuthEvent(
      call("/sign-in/email", {
        body: { email: "Ann@Example.com" },
        returned: refused("INVALID_EMAIL_OR_PASSWORD"),
        findUserIdByEmail: async (email) => (email === "ann@example.com" ? "u_ann" : null),
      }),
    )
    expect(event).toMatchObject({
      name: "auth.sign_in_failed",
      userId: "u_ann",
      outcome: "INVALID_EMAIL_OR_PASSWORD",
    })
  })

  it("records a failed sign-in for an unknown email with a null user", async () => {
    const event = await mapAuthEvent(
      call("/sign-in/email", {
        body: { email: "nobody@example.com" },
        returned: refused("INVALID_EMAIL_OR_PASSWORD"),
      }),
    )
    expect(event).toMatchObject({
      name: "auth.sign_in_failed",
      userId: null,
      outcome: "INVALID_EMAIL_OR_PASSWORD",
    })
  })

  it("does not look up an email on a successful sign-in", async () => {
    const findUserIdByEmail = vi.fn(async () => "u_other")
    await mapAuthEvent(
      call("/sign-in/email", {
        newSession: session("u_ann"),
        body: { email: "ann@x.io" },
        findUserIdByEmail,
      }),
    )
    expect(findUserIdByEmail).not.toHaveBeenCalled()
  })

  it("names an account change for the signed-in person, with no organization", async () => {
    const event = await mapAuthEvent(
      call("/change-password", {
        session: session("u_ann", "org_shared"),
        returned: { status: true },
      }),
    )
    expect(event).toMatchObject({
      name: "auth.password_changed",
      userId: "u_ann",
      organizationId: null,
      outcome: "ok",
    })
  })

  it("keeps the event name for a refused account change and uses the code as the outcome", async () => {
    const event = await mapAuthEvent(
      call("/change-password", {
        session: session("u_ann"),
        returned: refused("INVALID_PASSWORD"),
      }),
    )
    expect(event).toMatchObject({
      name: "auth.password_changed",
      userId: "u_ann",
      outcome: "INVALID_PASSWORD",
    })
  })

  it("names the organization for member changes from the body, else the active organization", async () => {
    const fromBody = await mapAuthEvent(
      call("/organization/update-member-role", {
        session: session("u_owner", "org_active"),
        body: { organizationId: "org_body", role: "admin" },
        returned: { id: "m1" },
      }),
    )
    expect(fromBody).toMatchObject({
      name: "auth.member_role_changed",
      organizationId: "org_body",
      userId: "u_owner",
    })

    const fromSession = await mapAuthEvent(
      call("/organization/remove-member", {
        session: session("u_owner", "org_active"),
        body: { memberIdOrEmail: "x" },
        returned: { member: {} },
      }),
    )
    expect(fromSession).toMatchObject({ name: "auth.member_removed", organizationId: "org_active" })
  })

  it("records an accepted invitation in the organization the invitation was for", async () => {
    const event = await mapAuthEvent(
      call("/organization/accept-invitation", {
        session: session("u_new", null),
        body: { invitationId: "inv_1" },
        returned: { invitation: { id: "inv_1" }, member: { organizationId: "org_invited" } },
      }),
    )
    expect(event).toMatchObject({
      name: "auth.invitation_accepted",
      userId: "u_new",
      organizationId: "org_invited",
      outcome: "ok",
    })
  })

  it("uses the organization the key was created for as the API key's organization", async () => {
    const event = await mapAuthEvent(
      call("/api-key/create", {
        session: session("u_ann", "org_active"),
        returned: { id: "key_1", referenceId: "org_key" },
      }),
    )
    expect(event).toMatchObject({
      name: "auth.api_key_created",
      organizationId: "org_key",
      userId: "u_ann",
    })
  })

  it("records an impersonation for the admin, with the target as the subject", async () => {
    const event = await mapAuthEvent(
      call("/admin/impersonate-user", {
        session: session("u_admin"),
        body: { userId: "u_target" },
        // The result is the target's session; the actor must still be the admin.
        returned: { session: {}, user: { id: "u_target" } },
      }),
    )
    expect(event).toMatchObject({
      name: "auth.impersonation_started",
      userId: "u_admin",
      subjectUserId: "u_target",
      organizationId: null,
    })
  })

  it("records a passkey registered without a session by the user the result names", async () => {
    const event = await mapAuthEvent(
      call("/passkey/verify-registration", {
        returned: { id: "pk_1", userId: "u_new", user: { id: "u_new" } },
      }),
    )
    expect(event).toMatchObject({ name: "auth.passkey_added", userId: "u_new" })
  })

  it("records a social callback as a sign-in only with a new session, else as a linked account", async () => {
    const signedIn = await mapAuthEvent(
      call("/callback/:id", { newSession: session("u_ann"), returned: {} }),
    )
    expect(signedIn?.name).toBe("auth.sign_in")

    const linked = await mapAuthEvent(
      call("/callback/:id", { session: session("u_ann"), returned: {} }),
    )
    expect(linked).toMatchObject({ name: "auth.account_linked", userId: "u_ann" })

    expect(await mapAuthEvent(call("/callback/:id", { returned: {} }))).toBeNull()
    expect(
      await mapAuthEvent(
        call("/callback/:id", { session: session("u_ann"), returned: refused("X") }),
      ),
    ).toBeNull()
  })

  it("records user deletion only once it is confirmed by the emailed token", async () => {
    expect(
      await mapAuthEvent(
        call("/delete-user", { session: session("u_ann"), body: {}, returned: {} }),
      ),
    ).toBeNull()
    expect(
      await mapAuthEvent(
        call("/delete-user", {
          session: session("u_ann"),
          body: { token: "tok" },
          returned: { success: true },
        }),
      ),
    ).toMatchObject({ name: "auth.user_deleted", userId: "u_ann" })
  })

  it("records a passkey sign-up's link as a sign-in, though its success is a redirect", async () => {
    // better-auth's redirect is a thrown APIError with status FOUND: it is the success, not a failure.
    const redirect = new APIError("FOUND", undefined, { location: "/welcome" })
    expect(
      await mapAuthEvent(
        call("/passkey-signup/verify", { newSession: session("u_new"), returned: redirect }),
      ),
    ).toMatchObject({ name: "auth.sign_in", userId: "u_new", outcome: "ok" })
    // A refused link (invalid, expired, reused, forged) creates no session: nothing is recorded.
    expect(
      await mapAuthEvent(
        call("/passkey-signup/verify", {
          returned: new APIError("FOUND", undefined, {
            location: "/sign-up/passkey?error=PASSKEY_SIGNUP_EXPIRED",
          }),
        }),
      ),
    ).toBeNull()
  })

  it("records a passkey sign-up start for the address's account, with a refusal's code", async () => {
    const lookup = async (email: string) => (email === "new@example.com" ? "u_new" : null)
    expect(
      await mapAuthEvent(
        call("/passkey-signup/start", {
          body: { email: "New@Example.com" },
          returned: { sent: true },
          findUserIdByEmail: lookup,
        }),
      ),
    ).toMatchObject({ name: "auth.sign_up_started", userId: "u_new", outcome: "ok" })
    expect(
      await mapAuthEvent(
        call("/passkey-signup/start", {
          body: { email: "taken@example.com" },
          returned: refused("ACCOUNT_EXISTS"),
          findUserIdByEmail: async () => "u_taken",
        }),
      ),
    ).toMatchObject({ name: "auth.sign_up_started", userId: "u_taken", outcome: "ACCOUNT_EXISTS" })
  })

  it("returns null for a path that isn't mapped", async () => {
    expect(await mapAuthEvent(call("/get-session", { session: session("u_ann") }))).toBeNull()
  })
})

describe("errorCodeOf", () => {
  it("uses better-auth's code, then the status, and INTERNAL for anything else", () => {
    expect(errorCodeOf(refused("INVALID_PASSWORD"))).toBe("INVALID_PASSWORD")
    expect(errorCodeOf(new APIError("UNAUTHORIZED", {}))).toBe("UNAUTHORIZED")
    expect(errorCodeOf(new Error("boom"))).toBe("INTERNAL")
  })
})

describe("path coverage", () => {
  // The paths the product's auth flows reach. Adding one to the mapper means adding it here too.
  const LISTED = [
    "/sign-in/email",
    "/magic-link/verify",
    "/two-factor/verify-totp",
    "/two-factor/verify-otp",
    "/two-factor/verify-backup-code",
    "/passkey/verify-authentication",
    "/callback/:id",
    "/sso/callback/:providerId",
    "/sign-out",
    "/change-password",
    "/reset-password",
    "/change-email",
    "/two-factor/enable",
    "/two-factor/disable",
    "/passkey/verify-registration",
    "/passkey/delete-passkey",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
    "/unlink-account",
    "/api-key/create",
    "/api-key/delete",
    "/sso/register",
    "/organization/update-member-role",
    "/organization/remove-member",
    "/organization/accept-invitation",
    "/admin/impersonate-user",
    "/admin/stop-impersonating",
    "/delete-user",
    "/delete-user/callback",
    "/passkey-signup/start",
    "/passkey-signup/verify",
  ]

  it("maps every listed endpoint", () => {
    expect([...AUTH_EVENT_PATHS].sort()).toEqual([...LISTED].sort())
  })

  it("only names events from the catalogue", () => {
    const names = new Set<string>(AUTH_EVENT_NAMES)
    expect(names.size).toBe(AUTH_EVENT_NAMES.length)
    expect(AUTH_EVENT_NAMES).toContain("auth.user_deleted")
  })
})

describe("authEvents plugin", () => {
  it("is a plugin with one after hook matched on the mapped paths", () => {
    const plugin = authEvents({ onAuthEvent: () => {} })
    expect(plugin.id).toBe("proof-auth-events")
    const [hook] = plugin.hooks?.after ?? []
    expect(hook).toBeDefined()
    const matcher = hook?.matcher as (ctx: { path?: string }) => boolean
    expect(matcher({ path: "/sign-in/email" })).toBe(true)
    expect(matcher({ path: "/get-session" })).toBe(false)
    expect(matcher({})).toBe(false)
  })
})

/** A real better-auth instance on PGlite, with the audit hook writing to `onAuthEvent`. */
async function instance(onAuthEvent: (event: AuthEvent) => void | Promise<void>) {
  const t = await createTestDb()
  const auth = createAuth({
    db: t.db,
    secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
    baseURL: BASE,
    emailFrom: "Test <auth@example.com>",
    oauthResources: [BASE, AUDIENCE],
    ses: {
      client: {
        send: async () => ({ MessageId: "test", $metadata: { requestId: "test" } }),
      },
    } as never,
    rateLimit: false,
    onAuthEvent,
  })
  await auth.api.signUpEmail({
    body: { email: "ann@example.com", password: "correct-horse-battery", name: "Ann" },
  })
  return { auth, close: t.close }
}

describe("authEvents on a real instance", () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    setErrorReporter(undefined)
    await drainAuthEvents()
    await close?.()
    close = undefined
  })

  it("records a failed sign-in for a known email, after the response", async () => {
    const events: AuthEvent[] = []
    const h = await instance((event) => {
      events.push(event)
    })
    close = h.close
    await expect(
      h.auth.api.signInEmail({
        body: { email: "ann@example.com", password: "wrong-password-here" },
      }),
    ).rejects.toBeInstanceOf(Error)
    await drainAuthEvents()
    expect(events).toEqual([
      expect.objectContaining({
        name: "auth.sign_in_failed",
        outcome: "INVALID_EMAIL_OR_PASSWORD",
        path: "/sign-in/email",
      }),
    ])
    expect(events[0]?.userId).toEqual(expect.any(String))
  })

  it("records a validation failure (better-call's APIError, not better-auth's) as a failed sign-in", async () => {
    const events: AuthEvent[] = []
    const h = await instance((event) => {
      events.push(event)
    })
    close = h.close
    // A malformed body fails validation before the endpoint runs; the error is better-call's.
    await expect(
      h.auth.api.signInEmail({ body: { email: "ann@example.com", password: 12345 } as never }),
    ).rejects.toThrow()
    await drainAuthEvents()
    expect(events).toEqual([
      expect.objectContaining({
        name: "auth.sign_in_failed",
        userId: expect.any(String),
        outcome: "VALIDATION_ERROR",
        path: "/sign-in/email",
      }),
    ])
  })

  it("returns the response before a slow audit write settles", async () => {
    let finished = false
    const h = await instance(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      finished = true
    })
    close = h.close
    await expect(
      h.auth.api.signInEmail({
        body: { email: "ann@example.com", password: "wrong-password-here" },
      }),
    ).rejects.toBeInstanceOf(Error)
    expect(finished).toBe(false)
    await drainAuthEvents()
    expect(finished).toBe(true)
  })

  it("reports an audit write that throws, and the auth response still succeeds", async () => {
    const reported: unknown[] = []
    setErrorReporter((error: AppError, context) => {
      reported.push({ error, context })
    })
    const h = await instance(() => {
      throw new Error("audit db down")
    })
    close = h.close
    const res = await h.auth.api.signInEmail({
      body: { email: "ann@example.com", password: "correct-horse-battery" },
    })
    expect(res.token).toEqual(expect.any(String))
    await drainAuthEvents()
    expect(reported).toEqual([
      {
        error: expect.objectContaining({ message: "audit db down" }),
        context: expect.objectContaining({ phase: "auth-event", path: "/sign-in/email" }),
      },
    ])
  })
})
