import { TWO_FACTOR_PATH, createClient } from "@proof/auth/client"
import type { SignInMethods, SocialProvider } from "@proof/auth/client"
import type { InboxFetchClient } from "@byo-oss/notifications/react"
import type { SupportFetchClient } from "@byo-oss/support/react"

import { rawSearch } from "./navigation"

/** An auth call that the server refused, with the message to show the person. */
export class WebError extends Error {
  readonly status: number
  /** The server's error code, when it has one (e.g. PASSWORD_COMPROMISED). */
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "WebError"
    this.status = status
    this.code = code
  }
}

export interface WebSession {
  /** `image`: the avatar URL, when the person has one. */
  user: { id: string; email: string; name: string; image?: string | null }
  activeOrganizationId: string | null
  /** The admin's user id while this session is an impersonation; null otherwise. */
  impersonatedBy?: string | null
}

export interface WebOrganization {
  id: string
  name: string
  slug: string
  /** The logo URL, when one was uploaded. */
  logo?: string | null
}

/** The roles better-auth stores on a membership, lowercased. Custom roles may be added later. */
export type MemberRole = string

export interface WebInvitation {
  id: string
  organizationName: string
  email: string
  role: string
  status: string
  /** ISO time the invitation stops working, when the server says. */
  expiresAt?: string
  /** The inviter's email, when the server says (better-auth may not return a name). */
  inviterEmail?: string
}

export interface DeviceLookup {
  status: "pending" | "approved" | "denied" | (string & {})
  clientId?: string
  scope?: string
}

/**
 * Everything the pages need from the server. Pages take this as a prop, so tests pass a fake and
 * the routes pass `getWebAuth()`. Methods that start an OAuth step resolve with the URL to continue
 * to (or `undefined` when there is none).
 */
export interface WebAuth {
  getSession(): Promise<WebSession | null>
  signIn(input: { email: string; password: string }): Promise<string | undefined>
  signUp(input: { name: string; email: string; password: string }): Promise<string | undefined>
  /** End the current session (the person is not who the page expects, or wants to switch). */
  signOut(): Promise<void>
  listOrganizations(): Promise<WebOrganization[]>
  /** The caller's role(s) in one organization, comma-separated when there are several. */
  memberRole(organizationId: string): Promise<MemberRole>
  /** True when the slug is free. Rejects other slugs (bad shape or taken) with `false`. */
  checkSlug(slug: string): Promise<boolean>
  createOrganization(input: { name: string; slug: string }): Promise<WebOrganization>
  setActiveOrganization(organizationId: string): Promise<void>
  /** The display name of an OAuth client, or null when it has none. */
  getClientName(clientId: string): Promise<string | null>
  /** Accept (true) or deny (false) the pending authorization for the active organization. */
  consent(accept: boolean): Promise<string | undefined>
  /** Resume the OAuth flow after the organization is chosen (`POST /oauth2/continue`). */
  continueOAuth(): Promise<string | undefined>
  getInvitation(invitationId: string): Promise<WebInvitation>
  acceptInvitation(invitationId: string): Promise<void>
  /** Decline the invitation (`organization/reject-invitation`). */
  rejectInvitation?(invitationId: string): Promise<void>

  // Sign-in methods. Optional so a page without them (tests, older fakes) stays password-only.
  /** Which methods this server offers on the sign-in page (GET /api/auth/sign-in-methods). */
  signInMethods?(): Promise<SignInMethods>
  /** The method the person last signed in with ("email", "passkey", "github", ...), or null. */
  lastUsedMethod?(): string | null
  /** Sign in with a registered passkey (the browser's WebAuthn prompt). */
  signInWithPasskey?(): Promise<void>
  /** Start a social sign-in; the browser goes to the provider and returns to `callbackURL`. */
  signInWithSocial?(provider: SocialProvider, callbackURL: string): Promise<void>
  /** Start an SSO sign-in for the address's domain; the browser goes to the identity provider. */
  signInWithSso?(email: string, callbackURL: string): Promise<void>
  /** Email a one-click sign-in link. Opening it signs the person in and lands on `callbackURL`. */
  sendMagicLink?(input: { email: string; callbackURL: string }): Promise<void>
  resetPassword(input: { token: string; newPassword: string }): Promise<void>
  /**
   * Email a reset link to the address. `redirectTo` must be this site (better-auth refuses others).
   * The page never says whether the address has an account, so this resolves the same either way.
   */
  requestPasswordReset?(input: { email: string; redirectTo: string }): Promise<void>
  /**
   * The person's notifications and unread count (@byo-oss/notifications' `inbox.*` endpoints), for the bell in
   * the top bar. Optional so pages and tests without it show no bell.
   */
  notifications?: InboxFetchClient
  /**
   * Support's endpoints (@byo-oss/support, `/api/auth/support/*`), for the support widget and the
   * support queue. Optional so pages and tests without it show no widget.
   */
  support?: SupportFetchClient
  device: {
    lookup(userCode: string): Promise<DeviceLookup>
    approve(userCode: string): Promise<void>
    deny(userCode: string): Promise<void>
  }
}

/** OAuth-style errors (device, consent) carry `error_description`; better-auth's own carry `message`. */
type Failable = {
  data: unknown
  error: { message?: string; error_description?: string; status?: number } | null
}

const unwrap = <T>(result: Failable, fallback: string): T => {
  if (result.error) {
    const message = result.error.message || result.error.error_description || fallback
    const code = (result.error as { code?: string }).code
    throw new WebError(message, result.error.status ?? 0, code)
  }
  return result.data as T
}

/** better-auth sends dates as Date objects or ISO strings; the pages want an ISO string or nothing. */
const toIso = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  const date = new Date(value as string | number | Date)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

const urlFrom = (body: { url?: string; redirect_uri?: string } | null | undefined) =>
  body?.url ?? body?.redirect_uri ?? undefined

export type AuthClient = ReturnType<typeof createClient>

/**
 * The better-auth client for a page: same origin by default, so session cookies go with every call.
 * The custom fetch is set only when given: an explicit undefined would replace better-auth's default.
 */
export function makeAuthClient(baseURL?: string, fetchImpl?: typeof fetch): AuthClient {
  return createClient(baseURL, fetchImpl ? { customFetchImpl: fetchImpl } : undefined)
}

/**
 * @byo-oss/notifications' hook takes its own client shape. This adapts the better-auth client's inbox
 * actions to it, so the page never needs a cast.
 */
function inboxFetchClient(inbox: AuthClient["inbox"]): InboxFetchClient {
  return {
    inbox: {
      list: ({ query }) => inbox.list({ query }),
      unreadCount: (input) => inbox.unreadCount(input),
      markRead: ({ id }) => inbox.markRead({ id }),
      markAllRead: (input) => inbox.markAllRead(input),
      markSeen: ({ ids }) => inbox.markSeen({ ids }),
    },
  }
}

/**
 * The browser implementation. Same-origin: the API serves these pages, so `baseURL` is the page's
 * origin and session cookies go with every request. The client's OAuth fetch plugin adds the page's
 * signed query to sign-in, sign-up, consent and continue, which is how those requests resume the flow.
 */
export function createWebAuth(baseURL?: string, fetchImpl?: typeof fetch): WebAuth {
  const client = makeAuthClient(baseURL, fetchImpl)

  return {
    notifications: inboxFetchClient(client.inbox),
    // The typed client already has support's shape (supportClient in @proof/auth/client).
    support: client,
    async getSession() {
      const result = await client.getSession()
      if (!result.data) return null
      const { user, session } = result.data
      return {
        user: { id: user.id, email: user.email, name: user.name, image: user.image ?? null },
        activeOrganizationId:
          (session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
        impersonatedBy:
          typeof (session as { impersonatedBy?: unknown }).impersonatedBy === "string"
            ? (session as { impersonatedBy: string }).impersonatedBy
            : null,
      }
    },
    async signIn(input) {
      const data = unwrap<{ url?: string; twoFactorRedirect?: boolean } | null>(
        await client.signIn.email(input),
        "Could not sign in",
      )
      // A second factor is still due: the client has already sent the browser to /two-factor, keeping
      // this page's query. Answer with that same address so the caller doesn't navigate elsewhere.
      if (data?.twoFactorRedirect) return `${TWO_FACTOR_PATH}${rawSearch()}`
      return data?.url ?? undefined
    },
    async signUp(input) {
      const data = unwrap<{ url?: string } | null>(
        await client.signUp.email(input),
        "Could not create the account",
      )
      return data?.url ?? undefined
    },
    async signOut() {
      unwrap(await client.signOut(), "Could not sign out")
    },
    async listOrganizations() {
      const orgs = unwrap<Array<{ id: string; name: string; slug: string; logo?: string | null }>>(
        await client.organization.list(),
        "Could not load organizations",
      )
      return orgs.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        logo: org.logo ?? null,
      }))
    },
    async memberRole(organizationId) {
      // Explicit organizationId: the session's active org is not necessarily the one asked about.
      const body = unwrap<{ role: string }>(
        await client.organization.getActiveMemberRole({ query: { organizationId } }),
        "Could not load your role",
      )
      return body.role
    },
    async checkSlug(slug) {
      const result = await client.organization.checkSlug({ slug })
      if (!result.error) return true
      // better-auth answers a taken slug with BAD_REQUEST and this code (organization/check-slug).
      const code = (result.error as { code?: string }).code
      if (code === "ORGANIZATION_SLUG_ALREADY_TAKEN") return false
      throw new WebError(
        result.error.message || "Could not check the address",
        result.error.status ?? 0,
      )
    },
    async createOrganization(input) {
      const org = unwrap<{ id: string; name: string; slug: string }>(
        await client.organization.create(input),
        "Could not create the organization",
      )
      return { id: org.id, name: org.name, slug: org.slug }
    },
    async setActiveOrganization(organizationId) {
      unwrap(
        await client.organization.setActive({ organizationId }),
        "Could not switch organization",
      )
    },
    async getClientName(clientId) {
      const result = await client.$fetch<{ client_name?: string }>("/oauth2/public-client", {
        method: "GET",
        query: { client_id: clientId },
      })
      return (
        unwrap<{ client_name?: string }>(result, "Could not load the application").client_name ??
        null
      )
    },
    async consent(accept) {
      const result = await client.$fetch<{ url?: string; redirect_uri?: string }>(
        "/oauth2/consent",
        { method: "POST", body: { accept } },
      )
      return urlFrom(unwrap(result, "Could not record your answer"))
    },
    async continueOAuth() {
      const result = await client.$fetch<{ url?: string; redirect_uri?: string }>(
        "/oauth2/continue",
        { method: "POST", body: { postLogin: true } },
      )
      return urlFrom(unwrap(result, "Could not continue"))
    },
    async getInvitation(invitationId) {
      const invitation = unwrap<{
        id: string
        organizationName: string
        email: string
        role: string
        status: string
      }>(
        await client.organization.getInvitation({ query: { id: invitationId } }),
        "This invitation could not be found",
      )
      return {
        id: invitation.id,
        organizationName: invitation.organizationName,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: toIso((invitation as { expiresAt?: unknown }).expiresAt),
        inviterEmail: (invitation as { inviterEmail?: string }).inviterEmail,
      }
    },
    async acceptInvitation(invitationId) {
      unwrap(
        await client.organization.acceptInvitation({ invitationId }),
        "Could not accept the invitation",
      )
    },
    async rejectInvitation(invitationId) {
      unwrap(
        await client.organization.rejectInvitation({ invitationId }),
        "Could not decline the invitation",
      )
    },
    async signInMethods() {
      return unwrap<SignInMethods>(
        await client.signInMethods(),
        "Could not load the sign-in options",
      )
    },
    lastUsedMethod() {
      return client.getLastUsedLoginMethod() ?? null
    },
    async signInWithPasskey() {
      unwrap(await client.signIn.passkey(), "Could not sign in with your passkey")
    },
    async signInWithSocial(provider, callbackURL) {
      unwrap(
        await client.signIn.social({ provider, callbackURL }),
        "Could not start sign-in with that provider",
      )
    },
    async signInWithSso(email, callbackURL) {
      unwrap(
        await client.signIn.sso({ email, callbackURL }),
        "No single sign-on is set up for that address",
      )
    },
    async sendMagicLink(input) {
      unwrap(
        await client.signIn.magicLink({ email: input.email, callbackURL: input.callbackURL }),
        "Could not send the sign-in link",
      )
    },
    async resetPassword(input) {
      unwrap(await client.resetPassword(input), "This link is invalid or has expired")
    },
    async requestPasswordReset(input) {
      unwrap(
        await client.requestPasswordReset({ email: input.email, redirectTo: input.redirectTo }),
        "Could not send the reset link",
      )
    },
    device: {
      async lookup(userCode) {
        const result = await client.$fetch<{ status: string; client_id?: string; scope?: string }>(
          "/device",
          { method: "GET", query: { user_code: userCode } },
        )
        const body = unwrap<{ status: string; client_id?: string; scope?: string }>(
          result,
          "That code was not recognised",
        )
        return { status: body.status, clientId: body.client_id, scope: body.scope }
      },
      async approve(userCode) {
        unwrap(
          await client.$fetch("/device/approve", { method: "POST", body: { userCode } }),
          "Could not approve the request",
        )
      },
      async deny(userCode) {
        unwrap(
          await client.$fetch("/device/deny", { method: "POST", body: { userCode } }),
          "Could not deny the request",
        )
      },
    },
  }
}

/** What the sign-in pages offer when the server's list is not loaded: email and password only. */
export const PASSWORD_ONLY_METHODS: SignInMethods = {
  password: true,
  magicLink: false,
  passkey: false,
  social: [],
  sso: false,
  stripe: false,
}

let shared: WebAuth | undefined

/** The page's own auth, created on first use in the browser (`window` is not there at build time). */
export function getWebAuth(): WebAuth {
  shared ??= createWebAuth(typeof window === "undefined" ? undefined : window.location.origin)
  return shared
}

/**
 * Sets the page's auth; undefined makes the next `getWebAuth` create it again. Tests render the real
 * router with a fake.
 */
export function setWebAuth(auth: WebAuth | undefined): void {
  shared = auth
}
