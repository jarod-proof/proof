import {
  ACTIVE_SUBSCRIPTION_CODE,
  LAST_SIGN_IN_METHOD_CODE,
  OWNS_ORGANIZATION_CODE,
  PASSWORD_COMPROMISED_CODE,
  PASSWORD_COMPROMISED_MESSAGE,
} from "@proof/auth/client"

import { SESSION_NOT_FRESH_CODE } from "./reauth"
import { makeAuthClient, WebError } from "./web-auth"

// The person's own account calls (profile, security): their name and email, sign-in methods, passkeys,
// two-factor, password and sessions. Nothing here names an organization. Each call is made by the
// signed-in person, so the server checks the session on every request.

export interface AccountProfile {
  id: string
  name: string
  email: string
  emailVerified: boolean
  /** The avatar URL: an upload, or the GitHub or Google picture from social sign-in. */
  image?: string | null
  /** The session's id of the current browser session (matches a SessionInfo's `token`). */
  currentSessionToken: string | null
}

export interface LinkedAccount {
  id: string
  providerId: string
  createdAt: string | Date | null
}

export interface PasskeyInfo {
  id: string
  name: string | null
  createdAt: string | Date | null
}

export interface SessionInfo {
  token: string
  userAgent: string | null
  createdAt: string | Date | null
  loginMethod: string | null
  loginTwoFactor: boolean
  current: boolean
}

export interface SecuritySummary {
  passwordChangedAt: string | Date | null
  twoFactorEnabled: boolean
  twoFactorEnabledAt: string | Date | null
  backupCodesRemaining: number | null
}

export interface TotpSetup {
  /** otpauth:// URI for an authenticator app. */
  totpURI: string
  backupCodes: string[]
}

/** A refused account call. `code` is better-auth's error code, when it has one. */
export class AccountError extends WebError {
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message, status)
    this.name = "AccountError"
    this.code = code
  }
}

/**
 * A call refused because the session is older than the fresh window (the server's SESSION_NOT_FRESH).
 * Its message is the person's copy, not the server's; `withReauth` (lib/reauth.ts) retries it after
 * a re-sign-in.
 */
export class SessionNotFreshError extends AccountError {
  constructor(status: number) {
    super(
      "Sign in again to continue. Changes like this need a recent sign-in.",
      status,
      SESSION_NOT_FRESH_CODE,
    )
    this.name = "SessionNotFreshError"
  }
}

/** The secret the authenticator app needs, from the otpauth URI's `secret` parameter. */
export function totpSecretOf(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get("secret") ?? ""
  } catch {
    return ""
  }
}

type Failure = { message?: string; status?: number; code?: string }
type Result<T> = { data: T | null; error: Failure | null }

function unwrap<T>(result: Result<T>, fallback: string): T {
  if (result.error) {
    if (result.error.code === SESSION_NOT_FRESH_CODE) {
      throw new SessionNotFreshError(result.error.status ?? 0)
    }
    throw new AccountError(
      result.error.message || fallback,
      result.error.status ?? 0,
      result.error.code,
    )
  }
  return result.data as T
}

/** The copy the person sees for a refused account call. Server messages are already written for people. */
export function accountErrorMessage(
  caught: unknown,
  fallback = "Something went wrong. Try again.",
) {
  if (!(caught instanceof AccountError)) {
    return caught instanceof Error && caught.message ? caught.message : fallback
  }
  switch (caught.code) {
    case PASSWORD_COMPROMISED_CODE:
      return PASSWORD_COMPROMISED_MESSAGE
    case LAST_SIGN_IN_METHOD_CODE:
      return "You can't disconnect your last way to sign in."
    case OWNS_ORGANIZATION_CODE:
    case ACTIVE_SUBSCRIPTION_CODE:
      return caught.message
    case "SESSION_NOT_FRESH":
    case "SESSION_EXPIRED":
      return "Sign in again to continue. Changes like this need a recent sign-in."
    case "PROVIDER_NOT_FOUND":
      return "This sign-in method isn't set up on this server yet."
    case "INVALID_PASSWORD":
      return "That password isn't right."
    case "INVALID_CODE":
      return "That code isn't right. Check the app and try again."
    case "INVALID_BACKUP_CODE":
      return "That backup code isn't right, or it has already been used."
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return "This account signs in without a password."
    default:
      return caught.message || fallback
  }
}

export interface AccountApi {
  getProfile(): Promise<AccountProfile>
  updateName(name: string): Promise<void>
  changeEmail(newEmail: string, callbackURL: string): Promise<void>
  /** Sends the confirmation link; nothing is deleted until it is opened. */
  requestAccountDeletion(callbackURL: string): Promise<void>
  listAccounts(): Promise<LinkedAccount[]>
  /** Starts the provider's sign-in to connect it; resolves with the URL to go to. */
  linkSocial(provider: string, callbackURL: string): Promise<string | undefined>
  unlinkAccount(accountId: string): Promise<void>
  listPasskeys(): Promise<PasskeyInfo[]>
  /** Registers a passkey on this device (WebAuthn). Rejects when the browser declines. */
  addPasskey(name: string): Promise<void>
  renamePasskey(id: string, name: string): Promise<void>
  deletePasskey(id: string): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  revokeSession(token: string): Promise<void>
  revokeOtherSessions(): Promise<void>
  securitySummary(): Promise<SecuritySummary>
  /** Step one of switching two-factor on: checks the password, returns the secret and the backup codes. */
  enableTwoFactor(password: string): Promise<TotpSetup>
  /** Step two: the first code from the app switches it on. */
  confirmTwoFactor(code: string): Promise<void>
  disableTwoFactor(password: string): Promise<void>
  /** New backup codes; the old ones stop working. */
  newBackupCodes(password: string): Promise<string[]>
  changePassword(input: {
    currentPassword: string
    newPassword: string
    revokeOtherSessions: boolean
  }): Promise<void>
  /** The second step of a sign-in that needs two-factor: an app code. Resolves with the URL to go to. */
  /** `trustDevice` skips the code on this browser for 30 days (better-auth's trusted-device cookie). */
  completeSignInWithCode(code: string, trustDevice?: boolean): Promise<string | undefined>
  /** The second step with a backup code, when the app is not to hand. */
  completeSignInWithBackupCode(code: string): Promise<string | undefined>
}

/** The browser implementation. Same origin as the page, so the session cookie goes with each call. */
export function createAccountApi(baseURL?: string, fetchImpl?: typeof fetch): AccountApi {
  const client = makeAuthClient(baseURL, fetchImpl)

  // The sign-in step's answer carries the continuation URL (the OAuth resume), as on the sign-in page.
  // The typed answers don't declare it: the OAuth provider's plugin adds it on the server.
  const continuation = (data: object | null | undefined) =>
    data && "url" in data && typeof data.url === "string" ? data.url : undefined

  return {
    async getProfile() {
      const result = await client.getSession()
      const session = unwrap(result, "Could not load your account")
      return {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        image: session.user.image ?? null,
        currentSessionToken: session.session.token,
      }
    },
    async updateName(name) {
      unwrap(await client.updateUser({ name }), "Could not save your name")
    },
    async changeEmail(newEmail, callbackURL) {
      unwrap(await client.changeEmail({ newEmail, callbackURL }), "Could not change your email")
    },
    async requestAccountDeletion(callbackURL) {
      unwrap(await client.deleteUser({ callbackURL }), "Could not start account deletion")
    },
    async listAccounts() {
      return unwrap(await client.listAccounts(), "Could not load connected accounts")
    },
    async linkSocial(provider, callbackURL) {
      const data = unwrap(await client.linkSocial({ provider, callbackURL }), "Could not connect")
      return data?.url ?? undefined
    },
    async unlinkAccount(accountId) {
      unwrap(await client.unlinkAccount({ accountId }), "Could not disconnect")
    },
    // The passkey plugin's client exposes only addPasskey; the list, rename and remove are its server
    // endpoints, called the way the security summary is.
    async listPasskeys() {
      return unwrap(
        await client.$fetch<PasskeyInfo[]>("/passkey/list-user-passkeys", { method: "GET" }),
        "Could not load passkeys",
      )
    },
    async addPasskey(name) {
      unwrap(await client.passkey.addPasskey({ name }), "Could not add the passkey")
    },
    async renamePasskey(id, name) {
      unwrap(
        await client.$fetch("/passkey/update-passkey", { method: "POST", body: { id, name } }),
        "Could not rename the passkey",
      )
    },
    async deletePasskey(id) {
      unwrap(
        await client.$fetch("/passkey/delete-passkey", { method: "POST", body: { id } }),
        "Could not remove the passkey",
      )
    },
    async listSessions() {
      const [sessions, current] = await Promise.all([client.listSessions(), client.getSession()])
      const currentToken = current.data?.session.token
      // loginMethod and loginTwoFactor are the session's own columns (packages/auth, login-method.ts);
      // the client's session type doesn't carry a server's additional fields.
      return unwrap(sessions, "Could not load your sessions").map((session) => ({
        token: session.token,
        userAgent: session.userAgent ?? null,
        createdAt: session.createdAt,
        loginMethod:
          "loginMethod" in session && typeof session.loginMethod === "string"
            ? session.loginMethod
            : null,
        loginTwoFactor: "loginTwoFactor" in session && session.loginTwoFactor === true,
        current: session.token === currentToken,
      }))
    },
    async revokeSession(token) {
      unwrap(await client.revokeSession({ token }), "Could not sign out that session")
    },
    async revokeOtherSessions() {
      unwrap(await client.revokeOtherSessions(), "Could not sign out the other sessions")
    },
    async securitySummary() {
      return unwrap(await client.securitySummary(), "Could not load your security settings")
    },
    async enableTwoFactor(password) {
      const setup = unwrap(
        await client.twoFactor.enable({ password }),
        "Could not start two-factor",
      )
      // The server is configured for an authenticator app (TOTP), never emailed codes.
      if (setup.method !== "totp") throw new AccountError("Could not start two-factor", 0)
      return { totpURI: setup.totpURI, backupCodes: setup.backupCodes }
    },
    async confirmTwoFactor(code) {
      unwrap(await client.twoFactor.verifyTotp({ code }), "That code isn't right")
    },
    async disableTwoFactor(password) {
      unwrap(await client.twoFactor.disable({ password }), "Could not turn off two-factor")
    },
    async newBackupCodes(password) {
      const data = unwrap(
        await client.twoFactor.generateBackupCodes({ password }),
        "Could not make new backup codes",
      )
      return data.backupCodes
    },
    async changePassword(input) {
      unwrap(await client.changePassword(input), "Could not change your password")
    },
    async completeSignInWithCode(code, trustDevice) {
      // The typed client omits trustDevice for verify-totp; the server schema accepts it (only when set).
      const body = trustDevice ? { code, trustDevice: true } : { code }
      return continuation(
        unwrap(
          await client.$fetch<{ url?: string; twoFactorRedirect?: boolean }>(
            "/two-factor/verify-totp",
            {
              method: "POST",
              body,
            },
          ),
          "That code isn't right",
        ),
      )
    },
    async completeSignInWithBackupCode(code) {
      return continuation(
        unwrap(await client.twoFactor.verifyBackupCode({ code }), "That backup code isn't right"),
      )
    },
  }
}

let shared: AccountApi | undefined

/** The page's own account API, created on first use in the browser. */
export function getAccountApi(): AccountApi {
  shared ??= createAccountApi(typeof window === "undefined" ? undefined : window.location.origin)
  return shared
}
