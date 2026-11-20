import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { vi } from "vitest"

/**
 * A GitHub App for tests that mint through the default minter: a throwaway RSA key in the
 * environment (the vault's place in production) and a fake GitHub as the global `fetch`. The fake
 * is at least as strict as the real one: it answers only the two routes the agent uses, and refuses
 * (401, 404 or 415, with GitHub's own wording) a request whose method, path, `Authorization:
 * Bearer <app JWT>` (RS256, verified with the app's public key, `iss` the app id, not expired),
 * `Accept` or `X-GitHub-Api-Version` is wrong, or whose token request body is not JSON. It records
 * each request, headers included. Call `restore()` (or `vi.unstubAllEnvs()` and
 * `vi.unstubAllGlobals()`) afterwards.
 */
export const APP_TOKEN = "ghs_FROMAPPKEY0123456789abcdefghijklmnopqr" // gitleaks:allow
export const APP_ID = "12345"
export const INSTALLATION_ID = "987"
export const APP_SLUG = "acme-factory"

export interface TokenRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** The JSON body: `repositories` and `permissions`, when narrowed. */
  body: { repositories?: string[]; permissions?: Record<string, string> }
}

const unauthorized = () =>
  new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })

/** The reason a bearer is not a valid app JWT, or null when it is one. */
function jwtProblem(authorization: string, publicPem: string): string | null {
  const [scheme, jwt, ...extra] = authorization.split(" ")
  if (scheme !== "Bearer" || !jwt || extra.length > 0) return "not a Bearer credential"
  const [header, payload, signature, ...rest] = jwt.split(".")
  if (!header || !payload || !signature || rest.length > 0) return "not a JWT"
  const json = (part: string) =>
    JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>
  if (json(header).alg !== "RS256") return "not RS256"
  const claims = json(payload)
  const now = Date.now() / 1000
  if (claims.iss !== APP_ID) return "wrong issuer"
  if (typeof claims.exp !== "number" || claims.exp <= now) return "expired"
  if (claims.exp - now > 600) return "valid for more than ten minutes"
  if (typeof claims.iat !== "number" || claims.iat > now) return "issued in the future"
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    createPublicKey(publicPem),
    Buffer.from(signature, "base64url"),
  )
  return valid ? null : "bad signature"
}

export function stubGitHubApp(...args: [token?: string, slug?: unknown]) {
  const token = args[0] ?? APP_TOKEN
  // An explicit `undefined` slug is a reply without one.
  const slug = args.length >= 2 ? args[1] : APP_SLUG
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  vi.stubEnv("GITHUB_APP_ID", APP_ID)
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", pem.replaceAll("\n", "\\n"))
  vi.stubEnv("GITHUB_INSTALLATION_ID", INSTALLATION_ID)
  const requests: TokenRequest[] = []
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as TokenRequest["body"]) : {}
    requests.push({ url: url.toString(), method, headers, body })

    if (url.origin !== "https://api.github.com") return new Response("", { status: 404 })
    if (headers.accept !== "application/vnd.github+json") {
      return new Response(JSON.stringify({ message: "Unsupported Accept" }), { status: 415 })
    }
    if (headers["x-github-api-version"] !== "2022-11-28") {
      return new Response(JSON.stringify({ message: "Unsupported API version" }), { status: 400 })
    }
    if (jwtProblem(headers.authorization ?? "", publicPem) !== null) return unauthorized()

    if (method === "GET" && url.pathname === "/app") {
      return new Response(JSON.stringify({ id: Number(APP_ID), slug }), { status: 200 })
    }
    if (
      method === "POST" &&
      url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`
    ) {
      if (init?.body !== undefined && !headers["content-type"]?.startsWith("application/json")) {
        return new Response(JSON.stringify({ message: "Unsupported Media Type" }), { status: 415 })
      }
      return new Response(JSON.stringify({ token, expires_at: "2099-01-01T00:00:00Z" }), {
        status: 201,
      })
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
  })
  return { requests, restore: () => (vi.unstubAllEnvs(), vi.unstubAllGlobals()) }
}
