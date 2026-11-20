import { passkeyClient } from "@better-auth/passkey/client"
import { createAuthClient } from "better-auth/client"
import { twoFactorClient } from "better-auth/client/plugins"

import { WebError } from "./web-auth"

// "Confirm it's you": a sensitive action refused because the session is older than the server's
// fresh window (one hour, packages/auth/src/fresh-session.ts). The person signs in again, the browser
// takes the new session cookie, and the action is retried once.

/** better-auth's code for a refused call (its guarded endpoints and the plugin's list both use it). */
export const SESSION_NOT_FRESH_CODE = "SESSION_NOT_FRESH"

/**
 * Whether a failed call was refused because the session is not fresh. Structural, so it covers the
 * shapes the web app sees: better-auth's client error and the app's own WebError or AccountError
 * (both carry `code`), a ProofError from the product client (`code`), and the raw product body
 * `{ error: { code } }`.
 */
export function isSessionNotFresh(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if ((error as { code?: unknown }).code === SESSION_NOT_FRESH_CODE) return true
  const nested = (error as { error?: unknown }).error
  return (
    nested !== null &&
    typeof nested === "object" &&
    (nested as { code?: unknown }).code === SESSION_NOT_FRESH_CODE
  )
}

/** Asks the person to confirm it's them. Resolves true once they have, false when they cancel. */
export type ReauthConfirm = () => Promise<boolean>

/**
 * Runs `action`. If it is refused as not fresh, asks for a re-sign-in and runs it once more. A
 * cancelled confirm, or a second refusal, rethrows the original error so the caller shows its copy.
 */
export async function withReauth<T>(action: () => Promise<T>, confirm: ReauthConfirm): Promise<T> {
  try {
    return await action()
  } catch (caught) {
    if (!isSessionNotFresh(caught)) throw caught
    const confirmed = await confirm()
    if (!confirmed) throw caught
    return action()
  }
}

/** The signed-in person, as the session says it. `token` changes when a new session replaces it. */
export interface ReauthSession {
  userId: string
  token: string
  /** The organization the session acts in. A new session starts in the person's first one. */
  activeOrganizationId: string | null
}

/**
 * The sign-in calls the dialog makes. Its own better-auth client, not the page's: the page's client
 * sends the browser to /two-factor when a code is due, and the dialog asks for the code in place.
 */
export interface ReauthAuth {
  session(): Promise<ReauthSession | null>
  /** "two-factor" when the account needs a code first; no new session exists until it is entered. */
  signInWithPassword(email: string, password: string): Promise<"done" | "two-factor">
  signInWithPasskey(): Promise<void>
  /** The code from the authenticator app. */
  verifyCode(code: string): Promise<void>
  verifyBackupCode(code: string): Promise<void>
  signOut(): Promise<void>
  /** Makes an organization the session's active one again (the sign-in picks the first). */
  setActiveOrganization(organizationId: string): Promise<void>
  /** Revokes one of the person's sessions by its token (the one a re-sign-in replaced). */
  revokeSession(token: string): Promise<void>
}

/**
 * Whether a re-sign-in really replaced the session. A new token for the same person is the only
 * good answer: the same token means the old cookie is still in use, and another person means a
 * passkey picked a different account, so the retry must not run.
 */
export function checkReauthed(
  before: ReauthSession | null,
  after: ReauthSession | null,
): "ok" | "not-replaced" | "other-account" {
  if (!after) return "not-replaced"
  if (before && after.userId !== before.userId) return "other-account"
  if (before && after.token === before.token) return "not-replaced"
  return "ok"
}

/**
 * Signs out the session that a confirmed re-sign-in replaced. Best effort: the new session is in
 * place already, so a failure here only leaves the old row listed, and must not stop the retry.
 */
export async function retireReplacedSession(
  auth: ReauthAuth,
  replaced: ReauthSession,
): Promise<void> {
  try {
    await auth.revokeSession(replaced.token)
  } catch {
    // The old row stays listed; the person can revoke it from the sessions list.
  }
}

/** Where "Sign out and sign in again" sends the person: back to `returnTo` after signing in. */
export function signInAgainPath(returnTo: string): string {
  return `/sign-in?next=${encodeURIComponent(returnTo)}`
}

type Failable = {
  data: unknown
  error: { message?: string; status?: number; code?: string } | null
}

function unwrap<T>(result: Failable, fallback: string): T {
  if (result.error) {
    throw new WebError(
      result.error.message || fallback,
      result.error.status ?? 0,
      result.error.code,
    )
  }
  return result.data as T
}

/** The reauth client. Same origin by default, so the session cookie goes with each call. */
export function createReauthAuth(baseURL?: string, fetchImpl?: typeof fetch): ReauthAuth {
  // No twoFactorClient options: its onTwoFactorRedirect would navigate the page away.
  const client = createAuthClient({
    baseURL,
    fetchOptions: fetchImpl ? { customFetchImpl: fetchImpl } : undefined,
    plugins: [passkeyClient(), twoFactorClient()],
  })

  return {
    async session() {
      const data = unwrap<{
        user: { id: string }
        session: { token: string; activeOrganizationId?: string | null }
      } | null>(await client.getSession(), "Could not check your sign-in")
      return data
        ? {
            userId: data.user.id,
            token: data.session.token,
            activeOrganizationId: data.session.activeOrganizationId ?? null,
          }
        : null
    },
    async signInWithPassword(email, password) {
      const data = unwrap<{ twoFactorRedirect?: boolean } | null>(
        await client.signIn.email({ email, password }),
        "Could not sign in",
      )
      return data?.twoFactorRedirect ? "two-factor" : "done"
    },
    async signInWithPasskey() {
      unwrap(await client.signIn.passkey(), "Could not sign in with your passkey")
    },
    async verifyCode(code) {
      unwrap(await client.twoFactor.verifyTotp({ code }), "That code isn't right")
    },
    async verifyBackupCode(code) {
      unwrap(await client.twoFactor.verifyBackupCode({ code }), "That backup code isn't right")
    },
    async signOut() {
      unwrap(await client.signOut(), "Could not sign out")
    },
    async revokeSession(token) {
      unwrap(await client.revokeSession({ token }), "Could not sign out that session")
    },
    async setActiveOrganization(organizationId) {
      // $fetch, not client.organization: this client has no organization plugin, only the session calls.
      unwrap(
        await client.$fetch("/organization/set-active", {
          method: "POST",
          body: { organizationId },
        }),
        "Could not switch organization",
      )
    },
  }
}

let shared: ReauthAuth | undefined

/** The page's reauth client, created on first use in the browser. */
export function getReauthAuth(): ReauthAuth {
  shared ??= createReauthAuth(typeof window === "undefined" ? undefined : window.location.origin)
  return shared
}
