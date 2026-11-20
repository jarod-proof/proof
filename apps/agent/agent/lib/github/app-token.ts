import { createPrivateKey, createSign } from "node:crypto"

/**
 * GitHub App installation tokens from the app's own private key, with no Vercel Connect in the
 * way: sign an RS256 JWT as the app, exchange it at `POST /app/installations/:id/access_tokens`
 * and narrow the result to the repositories and permissions a caller asks for.
 *
 * @remarks
 * eve ships helpers for this (`createGitHubAppJwt`) but does not export them, and its installation
 * token takes no narrowing, so this is the small minter Foreman's scoped leases need. The key comes
 * from the environment (the org's vault) and never leaves this module: nothing here logs, and no
 * error carries the key, the JWT or a token. The JWT is issued 60 seconds in the past (clock skew)
 * and lives nine minutes from now, inside GitHub's ten.
 */

/** GitHub refuses an app JWT valid for more than ten minutes. */
export const APP_JWT_MAX_LIFETIME_SECONDS = 600
const BACKDATE_SECONDS = 60
const LIFETIME_SECONDS = 540
const REQUEST_TIMEOUT_MS = 10_000

const APP_ID = /^[A-Za-z0-9._-]{1,64}$/
const INSTALLATION_ID = /^\d{1,20}$/

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url")

/**
 * A PEM as env files and vaults hold it: wrapped in quotes, or on one line with `\n` written out.
 * Real newlines are left alone.
 */
export function normalizePem(raw: string): string {
  let pem = raw.trim()
  if (pem.length >= 2 && /^(["']).*\1$/s.test(pem)) pem = pem.slice(1, -1)
  return pem.replaceAll("\\n", "\n")
}

/** An RS256 JWT naming the app, signed with its private key. `nowMs` is the clock. */
export function createAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  if (!APP_ID.test(appId)) throw new Error("The GitHub App id is missing or malformed.")
  const nowSeconds = Math.floor(nowMs / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = base64url(
    JSON.stringify({
      iat: nowSeconds - BACKDATE_SECONDS,
      exp: nowSeconds + LIFETIME_SECONDS,
      iss: appId,
    }),
  )
  const signingInput = `${header}.${claims}`
  try {
    const key = createPrivateKey(normalizePem(privateKeyPem))
    const signature = createSign("RSA-SHA256").update(signingInput).sign(key)
    return `${signingInput}.${base64url(signature)}`
  } catch {
    // No cause: it is not the place for anything about the key.
    throw new Error("The GitHub App private key could not be read (expected a PEM RSA key).")
  }
}

const LEVELS = new Set(["read", "write", "admin"])

/**
 * Permission strings (`contents:write`) as GitHub's request object (`{ contents: "write" }`). Null
 * is no narrowing: undefined, so the request carries no `permissions` key at all.
 */
export function parsePermissions(
  permissions: readonly string[] | null,
): Record<string, string> | undefined {
  if (permissions === null) return undefined
  const parsed: Record<string, string> = {}
  for (const entry of permissions) {
    const [name, level, ...rest] = entry.split(":")
    if (!name || !level || rest.length > 0 || !LEVELS.has(level)) {
      throw new Error(`"${entry}" is not a GitHub permission like contents:read.`)
    }
    parsed[name] = level
  }
  return parsed
}

export interface InstallationTokenRequest {
  appId: string
  /** The app's private key, PEM. From the vault; never logged. */
  privateKeyPem: string
  installationId: string
  /** Repository names (`widgets` or `acme/widgets`) to limit the token to; left out, every one. */
  repositories?: readonly string[]
  /** Permission levels to limit it to, such as `{ contents: "read" }`; left out, every one. */
  permissions?: Record<string, string>
  /** Injected in tests: a fake GitHub. Defaults to the global fetch at the time of the call. */
  fetch?: typeof fetch
  /** The clock in milliseconds, for tests. */
  now?: () => number
  /** GitHub's API host. Tests and GitHub Enterprise change it. */
  apiBaseUrl?: string
}

export interface InstallationToken {
  token: string
  /** ISO 8601, as GitHub gives it. */
  expiresAt: string
}

/**
 * Mint an installation token. Sends one request; a refusal is an Error naming GitHub's status and
 * message. Nothing is cached here: callers (the lease) decide how long to keep a token.
 */
export async function mintInstallationToken(
  request: InstallationTokenRequest,
): Promise<InstallationToken> {
  if (!INSTALLATION_ID.test(request.installationId)) {
    throw new Error("The GitHub installation id is missing or not a number.")
  }
  const send = request.fetch ?? globalThis.fetch
  const jwt = createAppJwt(request.appId, request.privateKeyPem, (request.now ?? Date.now)())
  const base = (request.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "")
  const repositories = request.repositories?.map((name) => name.split("/").pop() ?? name)
  const body = {
    ...(repositories === undefined ? {} : { repositories }),
    ...(request.permissions === undefined ? {} : { permissions: request.permissions }),
  }
  let response: Response
  try {
    response = await send(`${base}/app/installations/${request.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `GitHub could not be reached for an installation token: ${error instanceof Error ? error.name : "error"}`,
    )
  }
  const reply = (await response.json().catch(() => ({}))) as {
    token?: unknown
    expires_at?: unknown
    message?: unknown
  }
  if (!response.ok) {
    const said = typeof reply.message === "string" ? `: ${reply.message.slice(0, 300)}` : ""
    throw new Error(
      `GitHub refused the installation token request (HTTP ${response.status})${said}`,
    )
  }
  if (typeof reply.token !== "string" || reply.token === "") {
    throw new Error("GitHub answered the installation token request with no token.")
  }
  return {
    token: reply.token,
    expiresAt: typeof reply.expires_at === "string" ? reply.expires_at : "",
  }
}

export interface AppSlugRequest {
  appId: string
  /** The app's private key, PEM. From the vault; never logged. */
  privateKeyPem: string
  /** Injected in tests: a fake GitHub. Defaults to the global fetch at the time of the call. */
  fetch?: typeof fetch
  /** The clock in milliseconds, for tests. */
  now?: () => number
  /** GitHub's API host. Tests and GitHub Enterprise change it. */
  apiBaseUrl?: string
}

/**
 * The app's own slug, from `GET /app` under the app JWT (no installation involved). It is the
 * handle people `@mention`. A refusal or an answer without a slug is an Error naming GitHub's
 * status; no error carries the JWT, the key or the response body.
 */
export async function fetchAppSlug(request: AppSlugRequest): Promise<string> {
  const send = request.fetch ?? globalThis.fetch
  const jwt = createAppJwt(request.appId, request.privateKeyPem, (request.now ?? Date.now)())
  const base = (request.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "")
  let response: Response
  try {
    response = await send(`${base}/app`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `GitHub could not be reached for the app's slug: ${error instanceof Error ? error.name : "error"}`,
    )
  }
  if (!response.ok) {
    throw new Error(`GitHub refused the app lookup (HTTP ${response.status})`)
  }
  const reply = (await response.json().catch(() => ({}))) as { slug?: unknown }
  if (typeof reply.slug !== "string" || reply.slug === "") {
    throw new Error("GitHub answered the app lookup with no slug.")
  }
  return reply.slug
}
