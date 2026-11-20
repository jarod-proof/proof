// The device grant (RFC 8628) against the API's OAuth provider, and refresh. The endpoints and
// request shapes match apps/api/src/device-flow.test.ts: a public client registered with
// grant_types [device_code, refresh_token], the device code requested with `resource` set to the
// MCP endpoint, and polling with a form-encoded token request.
import { ProofError } from "@proof/sdk"
import type { Profile } from "./config"

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
export const DEFAULT_SCOPE = "openid offline_access read write"

// Without offline_access the server issues no refresh token, and a refresh token revoked when the
// approving web session signs out takes the access tokens issued from it down too.
export function withOfflineAccess(scope: string): string {
  const parts = scope.split(/\s+/).filter(Boolean)
  return parts.includes("offline_access") ? parts.join(" ") : [...parts, "offline_access"].join(" ")
}
const CLIENT_NAME = "proof CLI"
/** Seconds added to the poll interval on each slow_down (RFC 8628 section 3.5). */
const SLOW_DOWN_STEP_MS = 5000
/** Refresh this long before the access token expires, so a call never races the expiry. */
const REFRESH_SKEW_MS = 60_000

export interface Deps {
  fetch: (input: Request) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/** One request to the API origin. A connection failure becomes a ProofError like any other. */
export async function send(deps: Deps, request: Request): Promise<Response> {
  try {
    return await deps.fetch(request)
  } catch (cause) {
    throw new ProofError({
      status: 0,
      code: "NETWORK_ERROR",
      message: `Could not reach ${request.url}`,
      hint: "Check the base URL and your network connection, then retry.",
      cause,
    })
  }
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

/** The MCP endpoint of an origin: the resource the tokens are issued for. */
export const resourceOf = (baseUrl: string) => `${baseUrl}/mcp`

async function postJson(
  deps: Deps,
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await send(
    deps,
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }),
  )
  return readJson(response)
}

async function postForm(
  deps: Deps,
  url: string,
  fields: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await send(
    deps,
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(fields),
    }),
  )
  return readJson(response)
}

async function readJson(response: Response) {
  const parsed: unknown = await response.json().catch(() => null)
  const body =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  return { ok: response.ok, status: response.status, body }
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined)
const num = (value: unknown) => (typeof value === "number" ? value : undefined)

function tokenSetFrom(body: Record<string, unknown>, now: number, previous?: Profile): TokenSet {
  const accessToken = str(body.access_token)
  if (!accessToken) {
    throw new ProofError({
      status: 0,
      code: "LOGIN_FAILED",
      message: "The token response had no access_token",
    })
  }
  return {
    accessToken,
    // A refresh may rotate the refresh token or keep it: keep the old one when none is sent.
    refreshToken: str(body.refresh_token) ?? previous?.refreshToken,
    expiresAt: now + (num(body.expires_in) ?? 3600) * 1000,
    scope: str(body.scope) ?? previous?.scope,
  }
}

/** Registers this CLI as a public OAuth client for an origin. Returns its client_id. */
export async function registerClient(baseUrl: string, deps: Deps): Promise<string> {
  const res = await postJson(deps, `${baseUrl}/api/auth/oauth2/register`, {
    client_name: CLIENT_NAME,
    token_endpoint_auth_method: "none",
    grant_types: [DEVICE_GRANT, "refresh_token"],
  })
  const clientId = str(res.body.client_id)
  if (!res.ok || !clientId) {
    throw failure(res.status, res.body, "Could not register the CLI with the API")
  }
  return clientId
}

/** Asks for a device code. The caller shows the verification URL and user code to the person. */
export async function requestDeviceCode(
  baseUrl: string,
  clientId: string,
  scope: string,
  deps: Deps,
): Promise<DeviceCode> {
  const res = await postJson(deps, `${baseUrl}/api/auth/device/code`, {
    client_id: clientId,
    scope,
    resource: resourceOf(baseUrl),
  })
  const deviceCode = str(res.body.device_code)
  const userCode = str(res.body.user_code)
  const verificationUri = str(res.body.verification_uri)
  if (!res.ok || !deviceCode || !userCode || !verificationUri) {
    throw failure(res.status, res.body, "Could not start the sign-in")
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: str(res.body.verification_uri_complete),
    expiresIn: num(res.body.expires_in) ?? 600,
    interval: num(res.body.interval) ?? 5,
  }
}

/**
 * Polls the token endpoint until the person approves, honouring the interval the server gave and
 * backing off on slow_down. A dropped connection or a 5xx counts as still pending. Fails when the
 * person refuses or the code expires.
 */
export async function pollForTokens(
  baseUrl: string,
  clientId: string,
  device: DeviceCode,
  deps: Deps,
): Promise<TokenSet> {
  const deadline = deps.now() + device.expiresIn * 1000
  let intervalMs = device.interval * 1000
  for (;;) {
    if (deps.now() >= deadline) {
      throw new ProofError({
        status: 0,
        code: "expired_token",
        message: "The sign-in code expired before it was approved",
        hint: "Run proof login again.",
      })
    }
    await deps.sleep(intervalMs)
    const res = await postForm(deps, `${baseUrl}/api/auth/oauth2/token`, {
      grant_type: DEVICE_GRANT,
      device_code: device.deviceCode,
      client_id: clientId,
    }).catch((e: unknown) => {
      // A dropped connection mid-wait is not a refusal: poll again until the code expires.
      if (e instanceof ProofError && e.code === "NETWORK_ERROR") return undefined
      throw e
    })
    if (!res || res.status >= 500) continue
    // A rate limiter's 429 is the server's slow_down by another name, not a refusal.
    if (res.status === 429) {
      intervalMs += SLOW_DOWN_STEP_MS
      continue
    }
    if (res.ok) return tokenSetFrom(res.body, deps.now())
    switch (str(res.body.error)) {
      case "authorization_pending":
        continue
      case "slow_down":
        intervalMs += SLOW_DOWN_STEP_MS
        continue
      case "access_denied":
        throw new ProofError({
          status: res.status,
          code: "access_denied",
          message: "The sign-in was refused in the browser",
        })
      default:
        throw failure(res.status, res.body, "The sign-in failed")
    }
  }
}

/** Exchanges a refresh token for a new access token (and, if the server rotates it, a new refresh token). */
export async function refreshTokens(
  baseUrl: string,
  profile: Profile,
  deps: Deps,
): Promise<TokenSet> {
  if (!profile.refreshToken) {
    throw new ProofError({
      status: 0,
      code: "NOT_LOGGED_IN",
      message: "The stored session has no refresh token",
      hint: "Run proof login.",
    })
  }
  const res = await postForm(deps, `${baseUrl}/api/auth/oauth2/token`, {
    grant_type: "refresh_token",
    refresh_token: profile.refreshToken,
    client_id: profile.clientId,
  })
  // Only a client error means the refresh token is no good; a 5xx or 429 is the server's trouble.
  if (!res.ok && (res.status >= 500 || res.status === 429)) {
    throw failure(res.status, res.body, "The saved session could not be refreshed right now")
  }
  if (!res.ok) {
    throw new ProofError({
      status: res.status,
      code: "SESSION_EXPIRED",
      message: "The saved session could not be refreshed",
      hint: "Run proof login again.",
      cause: res.body,
    })
  }
  return tokenSetFrom(res.body, deps.now(), profile)
}

/** True when the stored access token is missing or close enough to expiry to refresh first. */
export function needsRefresh(profile: Profile, now: number): boolean {
  return profile.accessToken === undefined || (profile.expiresAt ?? 0) - REFRESH_SKEW_MS <= now
}

/** Best effort: asks the server to revoke the refresh token. Failures are ignored by the caller. */
export async function revokeRefreshToken(baseUrl: string, profile: Profile, deps: Deps) {
  if (!profile.refreshToken) return
  await postForm(deps, `${baseUrl}/api/auth/oauth2/revoke`, {
    token: profile.refreshToken,
    token_type_hint: "refresh_token",
    client_id: profile.clientId,
  })
}

function failure(status: number, body: Record<string, unknown>, fallback: string) {
  const code = str(body.error) ?? `HTTP_${status}`
  const description = str(body.error_description) ?? str(body.message)
  return new ProofError({ status, code, message: description ?? fallback })
}
