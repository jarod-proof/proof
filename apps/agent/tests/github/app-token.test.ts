import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import {
  APP_JWT_MAX_LIFETIME_SECONDS,
  createAppJwt,
  fetchAppSlug,
  mintInstallationToken,
  normalizePem,
  parsePermissions,
} from "#lib/github/app-token.js"
import { mintScopedToken, pemMinter, resetTokenScopeMemo, TOKEN_SCOPES } from "#lib/github/lease.js"
import { log } from "#lib/log.js"

const NOW = 1_800_000_000_000 // ms
const nowSeconds = NOW / 1000
const TOKEN = "ghs_INSTALLATIONTOKEN0123456789abcdefghij" // gitleaks:allow

let privatePem: string
let publicPem: string
let privatePkcs1: string

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
  privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  privatePkcs1 = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString()
  publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
})

const b64json = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>

/** Splits a JWT, checks its RS256 signature against the public key, returns the parts. */
function readJwt(jwt: string) {
  const [header, payload, signature, ...rest] = jwt.split(".")
  expect(rest).toEqual([])
  if (!header || !payload || !signature) throw new Error("not a JWT")
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    createPublicKey(publicPem),
    Buffer.from(signature, "base64url"),
  )
  return { header: b64json(header), claims: b64json(payload), valid }
}

interface Seen {
  url: string
  method: string
  authorization: string
  headers: Record<string, string>
  body: unknown
}

/** A fake GitHub: records each request and answers the installation token exchange. */
function fakeGitHub(
  reply: (seen: Seen) => { status: number; body: unknown } = () => ({
    status: 201,
    body: { token: TOKEN, expires_at: "2027-01-15T09:10:11Z" },
  }),
) {
  const seen: Seen[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    const record: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? "",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    }
    seen.push(record)
    const { status, body } = reply(record)
    return new Response(JSON.stringify(body), { status })
  }
  return { seen, fetch }
}

const base = () => ({
  appId: "12345",
  privateKeyPem: privatePem,
  installationId: "987",
  now: () => NOW,
})

describe("the app JWT", () => {
  test("is RS256, issued 60 seconds in the past and good for at most ten minutes", () => {
    const { header, claims, valid } = readJwt(createAppJwt("12345", privatePem, NOW))
    expect(header).toEqual({ alg: "RS256", typ: "JWT" })
    expect(valid).toBe(true)
    expect(claims.iss).toBe("12345")
    expect(claims.iat).toBe(nowSeconds - 60)
    expect(claims.exp as number).toBeGreaterThan(nowSeconds)
    // GitHub refuses a token that expires more than ten minutes ahead; stay inside it.
    expect((claims.exp as number) - nowSeconds).toBeLessThanOrEqual(600)
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(
      APP_JWT_MAX_LIFETIME_SECONDS,
    )
    expect(APP_JWT_MAX_LIFETIME_SECONDS).toBeLessThanOrEqual(600)
  })

  test("signs with a PKCS#1 key as GitHub hands it out, and a key whose newlines are escaped", () => {
    expect(readJwt(createAppJwt("1", privatePkcs1, NOW)).valid).toBe(true)
    expect(readJwt(createAppJwt("1", privatePem.replaceAll("\n", "\\n"), NOW)).valid).toBe(true)
    expect(normalizePem(`"${privatePem.replaceAll("\n", "\\n")}"`)).toBe(privatePem)
  })

  test("a signature from another key does not verify", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString()
    expect(readJwt(createAppJwt("1", other, NOW)).valid).toBe(false)
  })
})

describe("mintInstallationToken", () => {
  test("signs a JWT with RS256 and exchanges it for an installation token", async () => {
    const github = fakeGitHub()
    const minted = await mintInstallationToken({ ...base(), fetch: github.fetch })

    expect(minted).toEqual({ token: TOKEN, expiresAt: "2027-01-15T09:10:11Z" })
    expect(github.seen).toHaveLength(1)
    const [request] = github.seen
    expect(request?.method).toBe("POST")
    expect(request?.url).toBe("https://api.github.com/app/installations/987/access_tokens")
    // The bearer is the app JWT: RS256, verifiable with the app's public key, short-lived.
    const jwt = request?.authorization.replace(/^Bearer /, "") ?? ""
    const { header, claims, valid } = readJwt(jwt)
    expect(header.alg).toBe("RS256")
    expect(valid).toBe(true)
    expect(claims.iss).toBe("12345")
    expect((claims.exp as number) - nowSeconds).toBeLessThanOrEqual(600)
    expect(claims.iat as number).toBeLessThanOrEqual(nowSeconds - 60)
    // The headers GitHub requires on this route.
    expect(request?.headers.accept).toBe("application/vnd.github+json")
    expect(request?.headers["x-github-api-version"]).toBe("2022-11-28")
    expect(request?.headers["content-type"]).toBe("application/json")
    // No narrowing asked for: an empty body, so the token carries what the installation grants.
    expect(request?.body).toEqual({})
  })

  test("narrows the token to the repositories and permissions asked for, per call", async () => {
    const github = fakeGitHub()
    await mintInstallationToken({
      ...base(),
      fetch: github.fetch,
      repositories: ["widgets"],
      permissions: { contents: "read", pull_requests: "write" },
    })
    await mintInstallationToken({
      ...base(),
      fetch: github.fetch,
      repositories: ["widgets", "gadgets"],
      permissions: { contents: "write" },
    })
    expect(github.seen.map((s) => s.body)).toEqual([
      { repositories: ["widgets"], permissions: { contents: "read", pull_requests: "write" } },
      { repositories: ["widgets", "gadgets"], permissions: { contents: "write" } },
    ])
  })

  test("an owner/repo name is sent as the bare repo name GitHub expects", async () => {
    const github = fakeGitHub()
    await mintInstallationToken({ ...base(), fetch: github.fetch, repositories: ["acme/widgets"] })
    expect(github.seen[0]?.body).toEqual({ repositories: ["widgets"] })
  })

  test("a refusal says what GitHub said, and never carries the JWT, the key or a token", async () => {
    const spies = [
      vi.spyOn(log, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
    ]
    const github = fakeGitHub(() => ({
      status: 422,
      body: { message: "The permissions requested are not granted to this installation." },
    }))
    const failure = await mintInstallationToken({
      ...base(),
      fetch: github.fetch,
      permissions: { workflows: "write" },
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    const message = String((failure as Error).message)
    expect(message).toContain("422")
    expect(message).toContain("permissions requested are not granted")
    const jwt = github.seen[0]?.authorization.replace(/^Bearer /, "") ?? ""
    for (const secret of [jwt, privatePem, TOKEN, "BEGIN"]) {
      expect(message).not.toContain(secret)
      expect(String((failure as Error).stack)).not.toContain(secret)
    }
    // Nothing is logged: not on a failure, and not on a success.
    await mintInstallationToken({ ...base(), fetch: fakeGitHub().fetch })
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  test("a broken key is a clear error that does not print the key", async () => {
    const broken = "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----"
    const failure = await mintInstallationToken({
      ...base(),
      privateKeyPem: broken,
      fetch: fakeGitHub().fetch,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(String((failure as Error).message)).toMatch(/private key/i)
    expect(String((failure as Error).message)).not.toContain("bm90IGEga2V5")
  })

  test("a reply without a token is an error, not an empty token", async () => {
    const github = fakeGitHub(() => ({ status: 201, body: { expires_at: "2027-01-15T09:10:11Z" } }))
    await expect(mintInstallationToken({ ...base(), fetch: github.fetch })).rejects.toThrow(
      /no token/i,
    )
  })

  test("ids that are not plain are refused before anything is sent", async () => {
    const github = fakeGitHub()
    for (const bad of [{ installationId: "9/../x" }, { installationId: "" }, { appId: "" }]) {
      await expect(
        mintInstallationToken({ ...base(), ...bad, fetch: github.fetch }),
      ).rejects.toThrow()
    }
    expect(github.seen).toEqual([])
  })
})

describe("fetchAppSlug", () => {
  test("GETs /app under the app JWT with the headers GitHub requires, and returns the slug", async () => {
    const github = fakeGitHub(() => ({ status: 200, body: { id: 12345, slug: "acme-factory" } }))
    expect(
      await fetchAppSlug({
        appId: "12345",
        privateKeyPem: privatePem,
        fetch: github.fetch,
        now: () => NOW,
      }),
    ).toBe("acme-factory")
    const [request] = github.seen
    expect(github.seen).toHaveLength(1)
    expect(request?.method).toBe("GET")
    expect(request?.url).toBe("https://api.github.com/app")
    expect(request?.headers.accept).toBe("application/vnd.github+json")
    expect(request?.headers["x-github-api-version"]).toBe("2022-11-28")
    const { header, claims, valid } = readJwt(request?.authorization.replace(/^Bearer /, "") ?? "")
    expect([header.alg, claims.iss, valid]).toEqual(["RS256", "12345", true])
    expect(request?.body).toBeUndefined()
  })

  test("a refusal or an answer without a slug is an error that carries no JWT, key or body", async () => {
    const refused = fakeGitHub(() => ({
      status: 401,
      body: { message: "A JSON web token could not be decoded" },
    }))
    const failure = await fetchAppSlug({
      appId: "12345",
      privateKeyPem: privatePem,
      fetch: refused.fetch,
    }).catch((e: unknown) => e)
    expect(String((failure as Error).message)).toBe("GitHub refused the app lookup (HTTP 401)")
    const empty = fakeGitHub(() => ({ status: 200, body: {} }))
    await expect(
      fetchAppSlug({ appId: "12345", privateKeyPem: privatePem, fetch: empty.fetch }),
    ).rejects.toThrow(/no slug/)
  })
})

describe("permission strings", () => {
  test("map to GitHub's object form, and an empty or null request carries none", () => {
    expect(parsePermissions(["contents:write", "issues:read", "pull_requests:write"])).toEqual({
      contents: "write",
      issues: "read",
      pull_requests: "write",
    })
    expect(parsePermissions(null)).toBeUndefined()
    expect(() => parsePermissions(["contents"])).toThrow()
    expect(() => parsePermissions(["contents:owner"])).toThrow()
  })
})

describe("as the lease's default minter", () => {
  beforeEach(() => {
    resetTokenScopeMemo()
    vi.stubEnv("GITHUB_APP_ID", "12345")
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privatePem.replaceAll("\n", "\\n"))
    vi.stubEnv("GITHUB_INSTALLATION_ID", "987")
    vi.stubEnv("FACTORY_TOKEN_FALLBACK", "")
    vi.stubEnv("FACTORY_ALLOW_WORKFLOW_CHANGES", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test("a scoped lease asks GitHub for the factory repository and the scope's permissions only", async () => {
    const github = fakeGitHub()
    vi.stubGlobal("fetch", github.fetch)
    expect(await mintScopedToken("repo-push")).toBe(TOKEN)
    expect(github.seen[0]?.body).toEqual({
      repositories: ["widgets"],
      permissions: { contents: "write" },
    })
    const required = TOKEN_SCOPES["repo-push"].required
    expect(Object.keys((github.seen[0]?.body as { permissions: object }).permissions)).toHaveLength(
      required.length,
    )
  })

  test("the unnarrowed rung asks for no permissions at all, still for one repository", async () => {
    const github = fakeGitHub()
    vi.stubGlobal("fetch", github.fetch)
    expect(await pemMinter(null)).toBe(TOKEN)
    expect(github.seen[0]?.body).toEqual({ repositories: ["widgets"] })
  })

  test("without the app's id, key and installation it fails closed, naming what is missing", async () => {
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "")
    const github = fakeGitHub()
    vi.stubGlobal("fetch", github.fetch)
    await expect(pemMinter(["contents:read"])).rejects.toThrow(/GITHUB_APP_PRIVATE_KEY/)
    expect(github.seen).toEqual([])
  })

  test("reads its environment when it mints, not when the module loads", async () => {
    vi.stubEnv("GITHUB_INSTALLATION_ID", "111")
    const github = fakeGitHub()
    vi.stubGlobal("fetch", github.fetch)
    await pemMinter(["contents:read"])
    expect(github.seen[0]?.url).toContain("/app/installations/111/")
  })
})
