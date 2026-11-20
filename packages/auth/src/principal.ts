import { ORGANIZATION_HEADER, type PermissionSet } from "@proof/api"
import { AppError } from "@proof/errors"
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose"

import { API_KEY_PREFIX, AUTH_BASE_PATH, type Auth } from "./index"
import { type Adapter, memberGrants } from "./membership"
import { IMPERSONATION_GRANTS, narrow, scopePermissions } from "./permissions"
import { isImpersonated } from "./guards"

export type Actor = { type: "user"; userId: string } | { type: "apiKey"; keyId: string }

/** Who is calling, for which organization, and what they may do there. */
export interface Principal {
  organizationId: string
  actor: Actor
  via: "session" | "api-key" | "oauth"
  /**
   * One grant per role, each narrowed to what the credential allows. A request is allowed when one
   * grant covers all of it (better-auth's multi-role semantics). Use `allowed` from `@proof/api`.
   */
  grants: PermissionSet[]
  /** OAuth client id, or the API key id. */
  clientId?: string
  /** When a session principal's session was created: its sign-in age, for `fresh` operations. */
  sessionCreatedAt?: Date
}

export interface ResolveOptions {
  /** This resource's URL(s). OAuth tokens minted for another audience are rejected. */
  audience: string | string[]
}

function bearer(headers: Headers): string | undefined {
  const match = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim()
}

/** The OAuth provider's issuer: better-auth's base URL plus its base path. */
export function oauthIssuer(auth: Auth): string {
  const base = String(auth.options.baseURL ?? "").replace(/\/$/, "")
  return `${base}${AUTH_BASE_PATH}`
}

/**
 * Authenticate a request: an organization API key (`x-api-key` or `Bearer sk_…`), an OAuth access
 * token (JWT bound to one organization), or a session cookie (its active organization).
 * Membership is checked on every call, so removing a member takes effect immediately.
 * Returns null when nothing valid is present; throws AppError RATE_LIMITED for an over-limit key.
 */
export async function resolvePrincipal(
  auth: Auth,
  headers: Headers,
  opts: ResolveOptions,
): Promise<Principal | null> {
  const token = bearer(headers)
  const key = headers.get("x-api-key") ?? (token?.startsWith(API_KEY_PREFIX) ? token : undefined)
  const principal = key
    ? await fromApiKey(auth, key)
    : token
      ? await fromAccessToken(auth, token, opts)
      : await fromSession(auth, headers)
  if (principal) assertOrganizationHeader(principal, headers)
  return principal
}

/**
 * A product request may name the organization it is for (X-Organization-Id, sent by the web app
 * for the page it shows). It must be the one the credential acts for, or the call is refused: a
 * stale tab can't act on another organization. Absent, there is nothing to check.
 */
function assertOrganizationHeader(principal: Principal, headers: Headers): void {
  const requested = headers.get(ORGANIZATION_HEADER)
  if (requested === null || requested === principal.organizationId) return
  throw new AppError("CONFLICT", "The page acts for a different organization", {
    hint: "The request names an organization this credential doesn't act for. Reload the page, or switch organization in the org picker.",
  })
}

async function fromSession(auth: Auth, headers: Headers): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers })
  const orgId = session?.session.activeOrganizationId
  if (!session || !orgId) return null
  const roles = await memberGrants((await auth.$context).adapter, session.user.id, orgId)
  if (!roles) return null
  return {
    organizationId: orgId,
    actor: { type: "user", userId: session.user.id },
    via: "session",
    sessionCreatedAt: new Date(session.session.createdAt),
    // An admin impersonating this user gets read-only access, whatever the user's role allows.
    grants: isImpersonated(session) ? narrow(roles, IMPERSONATION_GRANTS as PermissionSet) : roles,
  }
}

async function fromApiKey(auth: Auth, key: string): Promise<Principal | null> {
  const res = await auth.api.verifyApiKey({ body: { key } })
  if (res.error?.code === "KEY_DISABLED") {
    // This app turns keys off at one point: the claim ends a provisional signup key. better-auth's
    // own key endpoints can disable others, so the hint doesn't assume which it was.
    throw new AppError("UNAUTHORIZED", "This API key is turned off", {
      hint:
        "If this key came from signup, it stopped working when the person claimed the account " +
        "(opened the emailed link). Sign in with the device grant instead: POST " +
        "/api/auth/device/code, then the person approves at /device (see /llms.txt, or run " +
        "`proof login`). Otherwise, ask an admin of the organization for a new key.",
    })
  }
  if (res.error?.code === "RATE_LIMITED") {
    // better-auth reports the wait in milliseconds; Retry-After is whole seconds, at least one.
    const details = (res.error as { details?: { tryAgainIn?: unknown } }).details
    const waitMs = Number(details?.tryAgainIn)
    const retryAfter = Math.max(1, Math.ceil((Number.isFinite(waitMs) ? waitMs : 0) / 1000))
    throw new AppError("RATE_LIMITED", "API key rate limit exceeded; retry later", {
      headers: { "retry-after": String(retryAfter) },
      hint: `Wait ${retryAfter} seconds before retrying, or use a key with a higher limit.`,
    })
  }
  if (!res.valid || !res.key) return null
  // Keys reference their organization without a foreign key; a deleted org's keys must stop working.
  const org = await (await auth.$context).adapter.findOne({
    model: "organization",
    where: [{ field: "id", value: res.key.referenceId }],
  })
  if (!org) return null
  const permissions = (res.key.permissions ?? {}) as PermissionSet
  return {
    organizationId: res.key.referenceId,
    actor: { type: "apiKey", keyId: res.key.id },
    via: "api-key",
    grants: Object.keys(permissions).length > 0 ? [permissions] : [],
    clientId: res.key.id,
  }
}

interface Grant {
  clientId: string
  organizationId: string
  userId: string
  /** When the access token was issued (whole seconds, as in its `iat`). */
  issuedAt: Date
}

/**
 * Whether the grant behind an OAuth access token still stands for this client, organization and
 * user. A grant is consent (authorization code clients, always written) or a live refresh token
 * (device-grant clients, which never get consent). revoke_agent_access deletes the consent and
 * revokes the refresh tokens, stamping `revoked`. A token issued before such a stamp fails even
 * when a new grant exists now. Rotation also stamps `revoked`, but sets `rotatedAt`, so rotated
 * rows don't count. Consent counts only when it predates the token, since better-auth writes
 * consent before it mints the token. Three point lookups, each keyed by the clientId index.
 */
async function grantStands(auth: Auth, grant: Grant, now: Date): Promise<boolean> {
  const db = (await auth.$context).adapter
  const who = [
    { field: "clientId", value: grant.clientId },
    { field: "referenceId", value: grant.organizationId },
    { field: "userId", value: grant.userId },
  ]
  const [consent, live, revocation] = await Promise.all([
    db.findOne<{ createdAt: Date | string }>({ model: "oauthConsent", where: who }),
    db.findOne<{ id: string }>({
      model: "oauthRefreshToken",
      where: [
        ...who,
        { field: "revoked", value: null },
        { field: "expiresAt", value: now, operator: "gt" },
      ],
    }),
    db.findOne<{ id: string }>({
      model: "oauthRefreshToken",
      where: [
        ...who,
        { field: "revoked", value: grant.issuedAt, operator: "gt" },
        { field: "rotatedAt", value: null },
      ],
    }),
  ])
  if (revocation) return false
  if (consent) return new Date(consent.createdAt).getTime() <= grant.issuedAt.getTime()
  return live !== null
}

/** Whether the user is banned now (admin plugin): `banned` set, with no end or one still ahead. */
async function isBanned(db: Adapter, userId: string, now: Date): Promise<boolean> {
  const user = await db.findOne<{ banned?: boolean | null; banExpires?: Date | string | null }>({
    model: "user",
    where: [{ field: "id", value: userId }],
  })
  if (!user) return true
  if (!user.banned) return false
  return !user.banExpires || new Date(user.banExpires).getTime() > now.getTime()
}

/** How long this server's signing keys are reused before they are fetched again. */
export const JWKS_TTL_MS = 60_000

const jwksCache = new WeakMap<Auth, { keys: LocalKeys; at: number }>()
type LocalKeys = ReturnType<typeof createLocalJWKSet>

/**
 * This server's public signing keys, cached per auth instance for JWKS_TTL_MS. The cache only
 * saves reads of the jwks table; a token signed with a key that rotated in since is handled by
 * verifyAccessToken, which fetches once more.
 */
async function signingKeys(auth: Auth, fresh = false): Promise<LocalKeys> {
  const cached = jwksCache.get(auth)
  if (!fresh && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys
  const keys = createLocalJWKSet((await auth.api.getJwks()) as JSONWebKeySet)
  jwksCache.set(auth, { keys, at: Date.now() })
  return keys
}

/** jose's error for a token whose `kid` names no key we hold (a key rotated since we cached). */
const isUnknownKey = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "ERR_JWKS_NO_MATCHING_KEY"

/**
 * Verify an access token's signature, audience and issuer. The keys are this server's own, so a
 * valid signature already means we issued the token. An unknown key id fetches the keys once more.
 */
async function verifyAccessToken(auth: Auth, token: string, opts: ResolveOptions) {
  const verify = (keys: LocalKeys) =>
    jwtVerify(token, keys, { audience: opts.audience, issuer: oauthIssuer(auth) })
  try {
    return await verify(await signingKeys(auth))
  } catch (error) {
    if (!isUnknownKey(error)) throw error
    return verify(await signingKeys(auth, true))
  }
}

async function fromAccessToken(
  auth: Auth,
  token: string,
  opts: ResolveOptions,
): Promise<Principal | null> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"]
  try {
    ;({ payload } = await verifyAccessToken(auth, token, opts))
  } catch {
    return null
  }
  // OAuth access tokens always name the client and the organization they were granted for.
  const clientId = payload.azp ?? payload.client_id
  if (!payload.sub || typeof clientId !== "string" || typeof payload.org !== "string") return null
  // A JWT has no row to revoke, so its grant is checked on every request (see grantStands).
  if (typeof payload.iat !== "number") return null
  const userId = payload.sub
  const organizationId = payload.org
  const grant = { clientId, organizationId, userId, issuedAt: new Date(payload.iat * 1000) }
  const now = new Date()
  const db = (await auth.$context).adapter
  // Independent reads, run together: membership, the ban, and the grant behind the token.
  const [roles, banned, stands] = await Promise.all([
    memberGrants(db, userId, organizationId),
    isBanned(db, userId, now),
    grantStands(auth, grant, now),
  ])
  // Removed members get nothing. A ban deletes the user's sessions but not their OAuth grants, so
  // their agents stop here.
  if (!roles || banned || !stands) return null
  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : []
  return {
    organizationId,
    actor: { type: "user", userId },
    via: "oauth",
    grants: narrow(roles, scopePermissions(scopes)),
    clientId,
  }
}
