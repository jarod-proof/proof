import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  githubAppId,
  githubCredentials,
  githubPrivateKey,
  githubWebhookSecret,
} from "#lib/github/credentials.js"
import {
  mintChannelToken,
  mintScopedToken,
  resetTokenScopeMemo,
  TOKEN_SCOPES,
  type TokenMinter,
} from "#lib/github/lease.js"
import { log } from "#lib/log.js"
import { APP_TOKEN, stubGitHubApp } from "./support/github-app.js"

const NARROW = "ghs_NARROWCHANNEL0123456789abcdefghijkl" // gitleaks:allow
const WIDE = "ghs_WIDEINSTALLATION0123456789abcdefghi" // gitleaks:allow

/**
 * What the channel module hands to eve, and what it asks GitHub for.
 *
 * @remarks
 * `agent/channels/github.ts` calls `githubChannel(...)` when it loads, so the
 * wiring tests replace that one function with a recorder and read the real
 * configuration the module passed. A mint with no injected minter goes to the
 * App-key minter (`app-token.ts`); a fake GitHub stands in for the global
 * `fetch` (`support/github-app.ts`) so it stays offline and the request it
 * sends can be read.
 */
const recorded = vi.hoisted(() => ({
  channelConfigs: [] as unknown[],
}))

vi.mock("eve/channels/github", () => ({
  githubChannel: (config: unknown) => {
    recorded.channelConfigs.push(config)
    return config
  },
}))

beforeEach(() => {
  resetTokenScopeMemo()
  vi.stubEnv("FACTORY_TOKEN_FALLBACK", "")
  vi.stubEnv("FACTORY_ALLOW_WORKFLOW_CHANGES", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("mintChannelToken: the token the GitHub channel itself uses", () => {
  test("is narrowed to issues and pull requests on the factory repository, contents read-only", async () => {
    const requests: (readonly string[] | null)[] = []
    const mint: TokenMinter = async (requested) => {
      requests.push(requested)
      return NARROW
    }
    expect(await mintChannelToken({ mint })).toBe(NARROW)
    const [permissions] = requests
    expect(permissions).toEqual([
      ...TOKEN_SCOPES["repo-triage"].required,
      ...TOKEN_SCOPES["repo-triage"].optional,
    ])
    // What the channel does: comment and react (issues, pull requests), read
    // the thread and a pull request's files (contents, pull requests).
    expect(permissions).toContain("issues:write")
    expect(permissions).toContain("pull_requests:write")
    expect(permissions).toContain("contents:read")
    // What it never needs: pushing, merging, workflows, administration.
    expect(permissions).not.toContain("contents:write")
    expect(permissions?.join(" ")).not.toMatch(/workflows|administration/)
  })

  test("never asks the connector for its unscoped token while narrowing works", async () => {
    let installationCalls = 0
    const token = await mintChannelToken({
      installationToken: async () => {
        installationCalls += 1
        return WIDE
      },
      mint: async () => NARROW,
    })
    expect(token).toBe(NARROW)
    expect(installationCalls).toBe(0)
  })

  test("an installation without the optional CI permissions still gets a narrowed token", async () => {
    const mint: TokenMinter = async (permissions) => {
      if (permissions?.includes("checks:read")) {
        throw new Error("422: permissions not granted to this installation")
      }
      return NARROW
    }
    let installationCalls = 0
    const token = await mintChannelToken({
      installationToken: async () => {
        installationCalls += 1
        return WIDE
      },
      mint,
    })
    expect(token).toBe(NARROW)
    expect(installationCalls).toBe(0)
  })

  test("falls back to the connector's token, and says so, when the connector refuses to narrow: the channel must still be able to answer", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined)
    const token = await mintChannelToken({
      installationToken: async () => WIDE,
      mint: async () => {
        throw new Error("422: cannot narrow")
      },
    })
    expect(token).toBe(WIDE)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /could not be narrowed.*using the connector's installation token/,
    )
  })

  test("the fallback does not depend on FACTORY_TOKEN_FALLBACK, and never leaks into the leased scopes", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => undefined)
    const refuse: TokenMinter = async () => {
      throw new Error("422: cannot narrow")
    }
    for (const setting of ["", "none", "repository"]) {
      resetTokenScopeMemo()
      vi.stubEnv("FACTORY_TOKEN_FALLBACK", setting)
      let installationCalls = 0
      const installationToken = async () => {
        installationCalls += 1
        return WIDE
      }
      // The repository-wide rung (null) is refused too, so only the
      // connector's own token is left.
      expect(await mintChannelToken({ installationToken, mint: refuse })).toBe(WIDE)
      expect(installationCalls).toBe(1)
      // A leased repo-triage token (the orchestrator's gh writes) does not
      // inherit what the channel fell back to: it is still refused.
      await expect(
        mintScopedToken("repo-triage", { installationToken, mint: refuse }),
      ).rejects.toThrow(/Could not mint a GitHub token for scope "repo-triage"/)
      expect(installationCalls).toBe(1)
    }
  })

  test("fails with the narrowing error when there is no connector token to fall back to", async () => {
    await expect(
      mintChannelToken({
        mint: async () => {
          throw new Error("422: cannot narrow")
        },
      }),
    ).rejects.toThrow(/Could not mint a GitHub token for scope "repo-triage"/)
  })
})

describe("the channel is wired to the narrowed token", () => {
  interface ChannelConfig {
    credentials: typeof githubCredentials & {
      installationToken: () => Promise<string>
    }
  }

  /** The configuration `agent/channels/github.ts` passed to `githubChannel`. */
  const channelConfig = async (): Promise<ChannelConfig> => {
    await import("#channels/github.js")
    expect(recorded.channelConfigs).toHaveLength(1)
    return recorded.channelConfigs[0] as ChannelConfig
  }

  let app: ReturnType<typeof stubGitHubApp>
  beforeEach(() => {
    app = stubGitHubApp()
  })
  afterEach(() => {
    app.restore()
  })

  test("the channel's installationToken asks GitHub for the repo-triage permissions on the factory repository alone", async () => {
    const { credentials } = await channelConfig()
    expect(await credentials.installationToken()).toBe(APP_TOKEN)
    expect(app.requests).toHaveLength(1)
    const [request] = app.requests
    // The route, verb and headers GitHub requires (the fake refuses a request that lacks them).
    expect(request?.method).toBe("POST")
    expect(request?.headers.accept).toBe("application/vnd.github+json")
    expect(request?.headers["x-github-api-version"]).toBe("2022-11-28")
    expect(request?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect({ url: request?.url, body: request?.body }).toEqual({
      url: "https://api.github.com/app/installations/987/access_tokens",
      body: {
        repositories: ["widgets"],
        permissions: {
          contents: "read",
          issues: "write",
          pull_requests: "write",
          actions: "read",
          checks: "read",
          statuses: "read",
        },
      },
    })
  })

  test("the channel is given the shared credentials, whose token is the narrowed one", async () => {
    const config = await channelConfig()
    expect(config.credentials).toBe(githubCredentials)
    expect(Object.keys(githubCredentials).sort()).toEqual([
      "appId",
      "installationToken",
      "privateKey",
      "webhookSecret",
    ])
  })

  test("the credentials are read when used: the app id, the key (newlines unescaped) and the webhook secret", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "whsec-test")
    expect(githubAppId()).toBe("12345")
    expect(githubPrivateKey()).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n?$/,
    )
    expect(githubWebhookSecret()).toBe("whsec-test")
  })

  test("the webhook secret is the HMAC key exactly as set: edge whitespace is kept, not trimmed", () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", " whsec-test\n")
    expect(githubWebhookSecret()).toBe(" whsec-test\n")
    // Blank is judged on the trimmed value only: whitespace alone still fails closed.
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", " \t\n ")
    expect(githubWebhookSecret).toThrow(/GITHUB_WEBHOOK_SECRET is not set/)
  })

  test("an unset or blank credential fails closed naming the variable, never an empty HMAC key", () => {
    for (const blank of ["", "   "]) {
      for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]) {
        vi.stubEnv(name, blank)
      }
      expect(githubAppId).toThrow(/GITHUB_APP_ID is not set/)
      expect(githubPrivateKey).toThrow(/GITHUB_APP_PRIVATE_KEY is not set/)
      expect(githubWebhookSecret).toThrow(/GITHUB_WEBHOOK_SECRET is not set/)
    }
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", undefined)
    expect(githubWebhookSecret).toThrow(/GITHUB_WEBHOOK_SECRET is not set/)
  })
})
