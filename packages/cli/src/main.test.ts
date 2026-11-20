import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type Credentials, credentialsPath, loadCredentials, saveCredentials } from "./config"
import { BASE, fakeApi, type FakeApi, TOKENS } from "./fake-api.test-helpers"
import { DEFAULT_BASE_URL, main, resolveBaseUrl } from "./main"

interface Harness {
  api: FakeApi
  dir: string
  waits: number[]
  run: (
    argv: string[],
    env?: Record<string, string | undefined>,
    stdin?: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>
  creds: () => Promise<Credentials>
}

let harness: Harness
let cleanup: () => Promise<void>

async function makeHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "proof-cli-"))
  const api = fakeApi()
  const waits: number[] = []
  let clock = Date.now()
  const baseEnv = { PROOF_CONFIG_DIR: dir, PROOF_URL: BASE }
  cleanup = () => rm(dir, { recursive: true, force: true })
  const run: Harness["run"] = async (argv, env = {}, stdin = "") => {
    let stdout = ""
    let stderr = ""
    const code = await main(argv, {
      env: { ...baseEnv, ...env },
      deps: {
        fetch: api.fetch,
        now: () => clock,
        sleep: async (ms) => {
          waits.push(ms)
          clock += ms
        },
      },
      io: {
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        readStdin: async () => stdin,
      },
    })
    return { code, stdout, stderr }
  }
  return {
    api,
    dir,
    waits,
    run,
    creds: () => loadCredentials(credentialsPath({ PROOF_CONFIG_DIR: dir })),
  }
}

/** A stored login for BASE whose access token is fresh unless `expiresAt` says otherwise. */
async function storeLogin(dir: string, expiresAt = Date.now() + 3_600_000) {
  await saveCredentials(credentialsPath({ PROOF_CONFIG_DIR: dir }), {
    current: BASE,
    profiles: {
      [BASE]: { clientId: "cli_1", accessToken: "at_1", refreshToken: "rt_1", expiresAt },
    },
  })
}

const parse = (text: string) => JSON.parse(text) as unknown
// stderr may carry a sign-in prompt before the JSON error, which is always the last object.
const errorOf = (stderr: string) => JSON.parse(stderr.slice(stderr.indexOf("{"))) as unknown

beforeEach(async () => {
  harness = await makeHarness()
})
afterEach(async () => {
  await cleanup()
})

describe("login", () => {
  it("registers, shows the code, polls through pending and slow_down, and stores the tokens", async () => {
    const { api, run, waits } = harness
    api.tokenPolls = [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: TOKENS },
    ]
    const result = await run(["login"])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`${BASE}/device`)
    expect(result.stderr).toContain("ABCD-1234")
    expect(parse(result.stdout)).toMatchObject({
      loggedIn: true,
      baseUrl: BASE,
      resource: `${BASE}/mcp`,
      scope: "read write offline_access",
    })
    // The interval (1s), again after pending, then 6s once the server said slow_down.
    expect(waits).toEqual([1000, 1000, 6000])

    const deviceBody = JSON.parse(
      api.calls.find((c) => c.path === "/api/auth/device/code")?.body ?? "{}",
    )
    expect(deviceBody).toEqual({
      client_id: "cli_1",
      scope: "openid offline_access read write",
      resource: `${BASE}/mcp`,
    })
    const tokenCall = api.calls.filter((c) => c.path === "/api/auth/oauth2/token")
    expect(new URLSearchParams(tokenCall[0]?.body).get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    )

    const creds = await harness.creds()
    expect(creds.current).toBe(BASE)
    expect(creds.profiles[BASE]).toMatchObject({
      clientId: "cli_1",
      accessToken: "at_1",
      refreshToken: "rt_1",
    })
  })

  it("keeps polling through a dropped connection or a 5xx while the person approves", async () => {
    const { api, run } = harness
    const real = api.fetch
    let dropped = false
    api.fetch = async (request) => {
      if (!dropped && new URL(request.url).pathname === "/api/auth/oauth2/token") {
        dropped = true
        throw new TypeError("fetch failed")
      }
      return real(request)
    }
    api.tokenPolls = [
      { status: 503, body: { error: "server_error" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: TOKENS },
    ]
    const result = await run(["login"])

    expect(result.code, result.stderr).toBe(0)
    expect((await harness.creds()).profiles[BASE]).toMatchObject({ accessToken: "at_1" })
  })

  it("slows down and keeps polling when the token endpoint answers 429", async () => {
    const { api, run, waits } = harness
    api.tokenPolls = [
      { status: 429, body: { message: "Too many requests" } },
      { status: 200, body: TOKENS },
    ]
    const result = await run(["login"])

    expect(result.code, result.stderr).toBe(0)
    expect(waits).toEqual([1000, 6000])
  })

  it("refuses plain http to a remote host, where the tokens would travel in clear", async () => {
    const result = await harness.run(["login", "--base-url", "http://api.example.com"])
    expect(result.code).toBe(2)
    expect(errorOf(result.stderr)).toMatchObject({ error: { code: "USAGE" } })
    expect(harness.api.calls).toEqual([])
  })

  it("allows plain http on this machine", async () => {
    const result = await harness.run(["whoami", "--base-url", "http://127.0.0.1:9"], {
      PROOF_URL: "",
    })
    // Not a usage error: the URL is accepted, then there is no login for it.
    expect(errorOf(result.stderr)).not.toMatchObject({ error: { code: "USAGE" } })
  })

  it("treats an empty PROOF_URL as unset", async () => {
    await storeLogin(harness.dir)
    const result = await harness.run(["whoami"], { PROOF_URL: "" })
    expect(result.code, result.stderr).toBe(0)
  })

  it("stores the credentials owner-only (0600)", async () => {
    await harness.run(["login"])
    const mode = (await stat(credentialsPath({ PROOF_CONFIG_DIR: harness.dir }))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("reuses the registered client on the next login", async () => {
    await harness.run(["login"])
    await harness.run(["login"])
    const registrations = harness.api.calls.filter((c) => c.path === "/api/auth/oauth2/register")
    expect(registrations).toHaveLength(1)
  })

  it("always asks for offline_access, so the session can be refreshed", async () => {
    await harness.run(["login", "--scope", "read write"])
    const body = JSON.parse(
      harness.api.calls.find((c) => c.path === "/api/auth/device/code")?.body ?? "{}",
    )
    expect(body.scope.split(" ")).toContain("offline_access")
    expect(body.scope.split(" ")).toEqual(expect.arrayContaining(["read", "write"]))
  })

  it("passes --scope through to the device request", async () => {
    await harness.run(["login", "--scope", "read"])
    const body = JSON.parse(
      harness.api.calls.find((c) => c.path === "/api/auth/device/code")?.body ?? "{}",
    )
    expect(body.scope).toBe("read offline_access")
  })

  it("prints the complete verification URL when the server gives one", async () => {
    harness.api.deviceReply = {
      status: 200,
      body: {
        device_code: "dev_1",
        user_code: "CODE",
        verification_uri: `${BASE}/device`,
        verification_uri_complete: `${BASE}/device?user_code=CODE`,
        expires_in: 600,
        interval: 1,
      },
    }
    const result = await harness.run(["login"])
    expect(result.stderr).toContain(`${BASE}/device?user_code=CODE`)
  })

  it("fails when the person refuses the sign-in", async () => {
    harness.api.tokenPolls = [{ status: 400, body: { error: "access_denied" } }]
    const result = await harness.run(["login"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({ error: { code: "access_denied" } })
  })

  it("fails with the server's description on an unexpected poll error", async () => {
    harness.api.tokenPolls = [
      { status: 400, body: { error: "invalid_grant", error_description: "Bad device code." } },
    ]
    const result = await harness.run(["login"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({
      status: 400,
      error: { code: "invalid_grant", message: "Bad device code." },
    })
  })

  it("gives up when the code expires before it is approved", async () => {
    harness.api.deviceReply = {
      status: 200,
      body: {
        device_code: "dev_1",
        user_code: "CODE",
        verification_uri: `${BASE}/device`,
        expires_in: 3,
        interval: 1,
      },
    }
    harness.api.tokenPolls = Array.from({ length: 5 }, () => ({
      status: 400,
      body: { error: "authorization_pending" },
    }))
    const result = await harness.run(["login"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({ error: { code: "expired_token" } })
  })

  it("fails when the device request is refused", async () => {
    harness.api.deviceReply = { status: 400, body: { error: "invalid_client" } }
    const result = await harness.run(["login"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({
      status: 400,
      error: { code: "invalid_client", message: "Could not start the sign-in" },
    })
  })

  it("fails when client registration is refused", async () => {
    harness.api.registerReply = { status: 403, body: { message: "Registration is closed." } }
    const result = await harness.run(["login"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({
      error: { code: "HTTP_403", message: "Registration is closed." },
    })
  })

  it("fails when the token response has no access token", async () => {
    harness.api.tokenPolls = [{ status: 200, body: { token_type: "Bearer" } }]
    const result = await harness.run(["login"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({ error: { code: "LOGIN_FAILED" } })
  })
})

describe("logout", () => {
  it("revokes the refresh token and forgets the login", async () => {
    await storeLogin(harness.dir)
    const result = await harness.run(["logout"])
    expect(result.code).toBe(0)
    expect(parse(result.stdout)).toEqual({ loggedOut: true, baseUrl: BASE })
    expect(harness.api.calls.some((c) => c.path === "/api/auth/oauth2/revoke")).toBe(true)
    const creds = await harness.creds()
    expect(creds.profiles[BASE]).toBeUndefined()
    expect(creds.current).toBeUndefined()
  })

  it("still forgets the login when the revoke call fails", async () => {
    await storeLogin(harness.dir)
    harness.api.routes["POST /api/auth/oauth2/revoke"] = { status: 500 }
    const result = await harness.run(["logout"])
    expect(result.code).toBe(0)
    expect((await harness.creds()).profiles[BASE]).toBeUndefined()
  })

  it("reports when there was nothing to log out of", async () => {
    const result = await harness.run(["logout"])
    expect(parse(result.stdout)).toEqual({ loggedOut: false, baseUrl: BASE })
  })

  it("keeps the current origin when logging out of another one", async () => {
    await storeLogin(harness.dir)
    const result = await harness.run(["logout", "--base-url", "https://other.test"])
    expect(parse(result.stdout)).toEqual({ loggedOut: false, baseUrl: "https://other.test" })
    expect((await harness.creds()).current).toBe(BASE)
  })
})

describe("whoami and authentication", () => {
  it("calls /v1/whoami with the stored access token", async () => {
    await storeLogin(harness.dir)
    const result = await harness.run(["whoami"])
    expect(result.code).toBe(0)
    expect(parse(result.stdout)).toEqual({ organizationId: "org_1", via: "oauth" })
    expect(harness.api.calls.at(-1)?.headers.get("authorization")).toBe("Bearer at_1")
  })

  it("sends PROOF_API_KEY as x-api-key in preference to a saved login", async () => {
    await storeLogin(harness.dir)
    await harness.run(["whoami"], { PROOF_API_KEY: "sk_live_1" })
    const last = harness.api.calls.at(-1)
    expect(last?.headers.get("x-api-key")).toBe("sk_live_1")
    expect(last?.headers.get("authorization")).toBeNull()
  })

  it("refreshes an expired access token first and keeps the rotated refresh token", async () => {
    await storeLogin(harness.dir, Date.now() - 1000)
    const result = await harness.run(["whoami"])
    expect(result.code).toBe(0)
    expect(harness.api.calls.at(-1)?.headers.get("authorization")).toBe("Bearer at_2")
    const creds = await harness.creds()
    expect(creds.profiles[BASE]).toMatchObject({
      accessToken: "at_2",
      refreshToken: "rt_2",
    })
  })

  it("keeps the refresh token when a refresh does not rotate it", async () => {
    await storeLogin(harness.dir, Date.now() - 1000)
    harness.api.refreshReply = {
      status: 200,
      body: { access_token: "at_next", expires_in: 60 },
    }
    await harness.run(["whoami"])
    expect((await harness.creds()).profiles[BASE]).toMatchObject({
      accessToken: "at_next",
      refreshToken: "rt_1",
    })
  })

  it("asks the person to log in again when the refresh is refused", async () => {
    await storeLogin(harness.dir, Date.now() - 1000)
    harness.api.refreshReply = { status: 400, body: { error: "invalid_grant" } }
    const result = await harness.run(["whoami"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({
      status: 400,
      error: { code: "SESSION_EXPIRED", hint: "Run proof login again." },
    })
  })

  it("does not call an unavailable server an expired session", async () => {
    await storeLogin(harness.dir, Date.now() - 1000)
    harness.api.refreshReply = { status: 503, body: { error: "server_error" } }
    const result = await harness.run(["whoami"])
    expect(result.code).toBe(1)
    const failure = errorOf(result.stderr) as { status: number; error: { code: string } }
    expect(failure.status).toBe(503)
    expect(failure.error.code).not.toBe("SESSION_EXPIRED")
    // The saved refresh token is still good, so it stays.
    expect((await harness.creds()).profiles[BASE]).toMatchObject({ refreshToken: "rt_1" })
  })

  it("refuses to call the API with no login and no key", async () => {
    const result = await harness.run(["whoami"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({ error: { code: "NOT_LOGGED_IN" } })
  })

  it("refuses a saved login that has no refresh token", async () => {
    await saveCredentials(credentialsPath({ PROOF_CONFIG_DIR: harness.dir }), {
      current: BASE,
      profiles: { [BASE]: { clientId: "cli_1", expiresAt: Date.now() - 1 } },
    })
    const result = await harness.run(["whoami"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({ error: { code: "NOT_LOGGED_IN" } })
  })

  it("surfaces a rate limit with its retry hint", async () => {
    await storeLogin(harness.dir)
    harness.api.routes["GET /v1/whoami"] = {
      status: 429,
      headers: { "retry-after": "0" },
      body: { error: { code: "RATE_LIMITED", message: "Too many calls." } },
    }
    const result = await harness.run(["whoami"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({
      status: 429,
      error: { code: "RATE_LIMITED" },
    })
  })
})

describe("ops", () => {
  it("lists the operations in the API's openapi.json", async () => {
    const result = await harness.run(["ops"], { PROOF_API_KEY: "k" })
    expect(result.code).toBe(0)
    const ops = parse(result.stdout) as { name: string; method: string; path: string }[]
    expect(ops).toContainEqual({
      name: "whoami",
      method: "GET",
      path: "/v1/whoami",
      summary: "Show the caller, its organization, permissions and usage",
    })
    expect(ops.map((op) => op.name)).toContain("create_project")
  })

  it("lists operations without a saved login or key", async () => {
    const result = await harness.run(["ops"])
    expect(result.code).toBe(0)
  })

  it("calls an operation declared with no security without any credential", async () => {
    const result = await harness.run(["call", "signup", "--json", '{"email": "a@b.test"}'])
    expect(result.code).toBe(0)
    expect(parse(result.stdout)).toMatchObject({ organizationId: "org_9" })
    const last = harness.api.calls.at(-1)
    expect(last?.headers.get("authorization")).toBeNull()
    expect(last?.headers.get("x-api-key")).toBeNull()
  })

  it("fails when the base URL does not serve openapi.json", async () => {
    harness.api.routes["GET /openapi.json"] = { status: 404 }
    const result = await harness.run(["ops"], { PROOF_API_KEY: "k" })
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({
      status: 404,
      error: { code: "HTTP_404", hint: "Check the base URL." },
    })
  })
})

describe("call", () => {
  const env = { PROOF_API_KEY: "k" }

  it("maps query fields onto the query string for a GET", async () => {
    const result = await harness.run(
      ["call", "list_projects", "--json", '{"limit": 5, "cursor": "abc"}'],
      env,
    )
    expect(result.code).toBe(0)
    expect(parse(result.stdout)).toEqual({ projects: [{ id: "p_1" }], nextCursor: null })
    const last = harness.api.calls.at(-1)
    expect(last?.method).toBe("GET")
    expect(last?.search).toBe("?cursor=abc&limit=5")
  })

  it("sends a JSON body and an Idempotency-Key on a POST", async () => {
    const result = await harness.run(
      ["call", "create_project", "--json", '{"name": "Website"}'],
      env,
    )
    expect(result.code).toBe(0)
    const last = harness.api.calls.at(-1)
    expect(last?.method).toBe("POST")
    expect(JSON.parse(last?.body ?? "")).toEqual({ name: "Website" })
    expect(last?.headers.get("idempotency-key")).toBeTruthy()
  })

  it("uses --idempotency-key when given, so a retry replays the same operation", async () => {
    await harness.run(
      ["call", "create_project", "--json", '{"name": "A"}', "--idempotency-key", "run-42"],
      env,
    )
    expect(harness.api.calls.at(-1)?.headers.get("idempotency-key")).toBe("run-42")
  })

  it("fills path parameters and leaves the rest as the body", async () => {
    await harness.run(["call", "delete_project", "--json", '{"id": "p 1"}'], env)
    const last = harness.api.calls.at(-1)
    expect(last?.method).toBe("DELETE")
    expect(last?.path).toBe("/v1/projects/p%201")
  })

  it("reads the input from a file with --input", async () => {
    const file = join(harness.dir, "input.json")
    await writeFile(file, '{"name": "From file"}')
    const result = await harness.run(["call", "create_project", "--input", file], env)
    expect(result.code).toBe(0)
    expect(JSON.parse(harness.api.calls.at(-1)?.body ?? "")).toEqual({ name: "From file" })
  })

  it("reads the input from stdin with --input -", async () => {
    const result = await harness.run(
      ["call", "create_project", "--input", "-"],
      env,
      '{"name": "From stdin"}',
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(harness.api.calls.at(-1)?.body ?? "")).toEqual({ name: "From stdin" })
  })

  it("treats no input as an empty object", async () => {
    const result = await harness.run(["call", "list_projects"], env)
    expect(result.code).toBe(0)
    expect(harness.api.calls.at(-1)?.search).toBe("")
  })

  it("treats whitespace-only input as no input", async () => {
    const result = await harness.run(["call", "list_projects", "--json", "   "], env)
    expect(result.code).toBe(0)
  })

  it("maps an API error to JSON on stderr and exit code 1", async () => {
    const result = await harness.run(["call", "list_audit_events"], env)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(errorOf(result.stderr)).toEqual({
      status: 403,
      error: { code: "FORBIDDEN", message: "Needs admin.", hint: "Use an admin login." },
    })
  })

  it("rejects an unknown operation as a usage error", async () => {
    const result = await harness.run(["call", "nope"], env)
    expect(result.code).toBe(2)
    expect(errorOf(result.stderr)).toMatchObject({
      error: { code: "USAGE", message: 'Unknown operation "nope"' },
    })
  })

  it("requires an operation name", async () => {
    const result = await harness.run(["call"], env)
    expect(result.code).toBe(2)
    expect(errorOf(result.stderr)).toMatchObject({ error: { code: "USAGE" } })
  })

  it("rejects input that is not a JSON object", async () => {
    const notJson = await harness.run(["call", "list_projects", "--json", "{oops"], env)
    expect(notJson.code).toBe(2)
    expect(errorOf(notJson.stderr)).toMatchObject({
      error: { message: "The input is not valid JSON" },
    })

    const array = await harness.run(["call", "list_projects", "--json", "[1]"], env)
    expect(array.code).toBe(2)
    expect(errorOf(array.stderr)).toMatchObject({
      error: { message: "The input must be a JSON object" },
    })
  })

  it("rejects --json together with --input", async () => {
    const result = await harness.run(
      ["call", "list_projects", "--json", "{}", "--input", "x.json"],
      env,
    )
    expect(result.code).toBe(2)
  })

  it("rejects a missing path parameter", async () => {
    const result = await harness.run(["call", "delete_project", "--json", "{}"], env)
    expect(result.code).toBe(2)
    expect(errorOf(result.stderr)).toMatchObject({
      error: { message: 'Missing path parameter "id" for delete_project' },
    })
  })

  it("rejects a path parameter that is not a scalar", async () => {
    const result = await harness.run(["call", "delete_project", "--json", '{"id": {"a": 1}}'], env)
    expect(result.code).toBe(2)
    expect(errorOf(result.stderr)).toMatchObject({
      error: { message: 'Parameter "id" must be a string, number or boolean' },
    })
  })

  it("retries an unreachable API, then reports NETWORK_ERROR", async () => {
    harness.api.fetch = async () => {
      throw new TypeError("fetch failed")
    }
    const result = await harness.run(["whoami"], env)
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({
      status: 0,
      error: { code: "NETWORK_ERROR", message: `Could not reach ${BASE}/v1/whoami` },
    })
    // A GET is retried three times, with a wait before each retry.
    expect(harness.waits).toHaveLength(3)
  })
})

describe("arguments and help", () => {
  it("prints help with no command", async () => {
    const result = await harness.run([])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("proof login")
  })

  it("prints help for --help", async () => {
    const result = await harness.run(["call", "--help"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Usage:")
  })

  it("rejects an unknown command", async () => {
    const result = await harness.run(["frobnicate"])
    expect(result.code).toBe(2)
    expect(errorOf(result.stderr)).toMatchObject({
      error: { message: 'Unknown command "frobnicate"' },
    })
  })

  it("rejects an unknown flag", async () => {
    const result = await harness.run(["ops", "--bogus"])
    expect(result.code).toBe(2)
    expect(errorOf(result.stderr)).toMatchObject({ error: { code: "USAGE" } })
  })

  it("rejects a base URL that is not a URL, and one with another scheme", async () => {
    const notUrl = await harness.run(["ops", "--base-url", "api.test"])
    expect(notUrl.code).toBe(2)
    expect(errorOf(notUrl.stderr)).toMatchObject({ error: { message: "Not a URL: api.test" } })

    const scheme = await harness.run(["ops", "--base-url", "ftp://api.test"])
    expect(scheme.code).toBe(2)
    expect(errorOf(scheme.stderr)).toMatchObject({
      error: { message: "Unsupported URL scheme in ftp://api.test" },
    })
  })

  it("uses --base-url over PROOF_URL", async () => {
    harness.api.routes["GET /openapi.json"] = { status: 200, body: { paths: {} } }
    const result = await harness.run(["ops", "--base-url", "https://flag.test/"], {
      PROOF_API_KEY: "k",
    })
    expect(result.code).toBe(0)
    expect(harness.api.calls.at(-1)?.path).toBe("/openapi.json")
  })

  it("reports an unreachable base URL when reading openapi.json", async () => {
    harness.api.fetch = async () => {
      throw new TypeError("fetch failed")
    }
    const result = await harness.run(["ops"], { PROOF_API_KEY: "k" })
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({ error: { code: "NETWORK_ERROR" } })
  })

  it("reports a corrupt credentials file rather than ignoring it", async () => {
    await writeFile(credentialsPath({ PROOF_CONFIG_DIR: harness.dir }), '"just a string"')
    const result = await harness.run(["whoami"])
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({
      error: { code: "INTERNAL", message: expect.stringContaining("not a credentials file") },
    })
  })

  it("rewrites the credentials file in place", async () => {
    await storeLogin(harness.dir)
    await saveCredentials(credentialsPath({ PROOF_CONFIG_DIR: harness.dir }), {
      profiles: {},
    })
    const text = await readFile(credentialsPath({ PROOF_CONFIG_DIR: harness.dir }), "utf8")
    expect(JSON.parse(text)).toEqual({ profiles: {} })
  })
})

describe("default base URL", () => {
  it("is the product's public origin, not a local server", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.example.com")
    expect(resolveBaseUrl({}, {}, { profiles: {} })).toBe("https://api.example.com")
  })

  it("is overridden by PROOF_URL, then by the last login", () => {
    expect(resolveBaseUrl({}, { PROOF_URL: BASE }, { profiles: {} })).toBe(BASE)
    expect(resolveBaseUrl({}, {}, { current: "http://localhost:3000", profiles: {} })).toBe(
      "http://localhost:3000",
    )
  })

  it("is what a credential-less call names when nothing is set", async () => {
    const result = await harness.run(["whoami"], { PROOF_URL: "" })
    expect(result.code).toBe(1)
    expect(errorOf(result.stderr)).toMatchObject({
      error: { code: "NOT_LOGGED_IN", message: "No saved login for https://api.example.com" },
    })
  })
})
