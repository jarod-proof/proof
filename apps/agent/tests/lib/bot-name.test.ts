import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { FALLBACK_BOT_NAME, mentionPattern } from "#lib/github/bot-name.js"
import { stubGitHubApp } from "../github/support/github-app.js"

// `resolveBotName` asks GitHub for the app's slug (`GET /app`, signed with the app's JWT). The fake
// GitHub in `support/github-app.ts` answers it and refuses a request GitHub would refuse.
describe("resolveBotName", () => {
  // The resolved name is kept for the life of the module, so each test loads the module afresh.
  const load = async () => (await import("#lib/github/bot-name.js")).resolveBotName
  let app: ReturnType<typeof stubGitHubApp> | undefined
  const slugRequests = () => app?.requests.filter((r) => r.url.endsWith("/app")) ?? []

  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("FACTORY_BOT_NAME", undefined)
    vi.stubEnv("GITHUB_APP_SLUG", undefined)
  })

  afterEach(() => {
    app?.restore()
    app = undefined
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test("FACTORY_BOT_NAME wins, then GITHUB_APP_SLUG, and neither asks GitHub", async () => {
    app = stubGitHubApp()
    const resolveBotName = await load()
    vi.stubEnv("GITHUB_APP_SLUG", "from-slug")
    expect(await resolveBotName()).toBe("from-slug")
    vi.stubEnv("FACTORY_BOT_NAME", "from-name")
    expect(await resolveBotName()).toBe("from-name")
    expect(app.requests).toEqual([])
  })

  test("with no override, the name is the app's slug from GET /app, asked for once", async () => {
    app = stubGitHubApp(undefined, "foreman-agent")
    const resolveBotName = await load()

    expect(await resolveBotName()).toBe("foreman-agent")
    expect(await resolveBotName()).toBe("foreman-agent")
    expect(slugRequests()).toHaveLength(1)
    const [request] = slugRequests()
    expect(request?.method).toBe("GET")
    expect(request?.url).toBe("https://api.github.com/app")
    // The fake only answers a valid RS256 app JWT, the Accept and the API version; it did.
    expect(request?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(request?.headers.accept).toBe("application/vnd.github+json")
    expect(request?.headers["x-github-api-version"]).toBe("2022-11-28")
  })

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["not text", 42],
    ["longer than a name may be before it goes into a pattern", "a".repeat(81)],
    ["upper case (GitHub slugs are lower case)", "Acme-Factory"],
    ["not a slug", "evil name (x)"],
  ])("refuses a slug that is %s", async (_case, slug) => {
    app = stubGitHubApp(undefined, slug)
    const resolveBotName = await load()

    await expect(resolveBotName()).rejects.toThrow(/no (usable )?(GitHub App )?slug/i)
  })

  test("accepts a slug at the length limit", async () => {
    app = stubGitHubApp(undefined, "a".repeat(80))

    expect(await (await load())()).toBe("a".repeat(80))
  })

  test("does not remember a failure: the next call asks again", async () => {
    app = stubGitHubApp(undefined, "")
    const resolveBotName = await load()
    await expect(resolveBotName()).rejects.toThrow()

    app.restore()
    app = stubGitHubApp(undefined, "foreman-agent")
    expect(await resolveBotName()).toBe("foreman-agent")
    expect(slugRequests()).toHaveLength(1)
  })

  test("an unreachable GitHub is an error naming no secret", async () => {
    app = stubGitHubApp()
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed: secret-host")))
    const resolveBotName = await load()

    const failure = await resolveBotName().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/could not be reached/)
    expect((failure as Error).message).not.toMatch(/BEGIN|Bearer|secret-host/)
  })

  test("a refusal from GitHub (bad credentials) is an error with the status only", async () => {
    app = stubGitHubApp()
    vi.stubEnv("GITHUB_APP_ID", "99999")
    const resolveBotName = await load()

    await expect(resolveBotName()).rejects.toThrow("GitHub refused the app lookup (HTTP 401)")
  })

  test("without the app's id and key it fails closed before any request", async () => {
    app = stubGitHubApp()
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "")
    const resolveBotName = await load()

    await expect(resolveBotName()).rejects.toThrow(/GITHUB_APP_PRIVATE_KEY is not set/)
    expect(app.requests).toEqual([])
  })
})

describe("mentionPattern", () => {
  const foreman = mentionPattern("Foreman")

  test.each([
    "@Foreman",
    "@Foreman please take this",
    "Hey @Foreman, can you look?",
    "cc @Foreman.",
    "(@Foreman)",
    "thanks @Foreman!",
    "@Foreman: status?",
    "line one\n@Foreman\nline three",
    "ping @Foreman's queue",
    "> quoted @Foreman",
  ])("matches the mention in %j", (text) => {
    expect(foreman.test(text)).toBe(true)
  })

  test.each(["@foreman", "@FOREMAN", "@fOrEmAn take this"])(
    "matches %j whatever its case",
    (text) => {
      expect(foreman.test(text)).toBe(true)
    },
  )

  test.each([
    ["a longer handle", "@Foremans"],
    ["a longer handle with digits", "@Foreman2"],
    ["a hyphenated handle", "@Foreman-extra"],
    ["a handle ending in a hyphen", "@Foreman-"],
    ["an underscored handle", "@Foreman_x"],
    ["a different handle sharing the prefix", "@ForemanBot please"],
    ["the name without an @", "Foreman, take this"],
    ["a shorter handle", "@Forema"],
    ["an @ separated from the name", "@ Foreman"],
    ["an empty comment", ""],
  ])("does not match %s", (_case, text) => {
    expect(foreman.test(text)).toBe(false)
  })

  test("gives the same answer every time it is asked", () => {
    const text = "Hey @Foreman, can you look?"

    expect([foreman.test(text), foreman.test(text), foreman.test(text)]).toEqual([true, true, true])
  })

  test("matches the default persona's own name", () => {
    expect(mentionPattern(FALLBACK_BOT_NAME).test(`@${FALLBACK_BOT_NAME} hi`)).toBe(true)
  })

  test("matches a hyphenated app slug whole", () => {
    const pattern = mentionPattern("foreman-agent")

    expect(pattern.test("@foreman-agent take this")).toBe(true)
    expect(pattern.test("@Foreman-Agent[bot]")).toBe(true)
    expect(pattern.test("@foreman take this")).toBe(false)
    expect(pattern.test("@foreman-agent-staging take this")).toBe(false)
  })

  test("reads a dot in the name literally", () => {
    const pattern = mentionPattern("a.b")

    expect(pattern.test("@a.b hello")).toBe(true)
    expect(pattern.test("@axb hello")).toBe(false)
    expect(pattern.test("@a-b hello")).toBe(false)
  })

  test.each([
    ["a star", "bot*", "@bot*", ["@bot", "@bottt", "@bo"]],
    ["a plus", "c++", "@c++", ["@c", "@cc", "@c+"]],
    ["a question mark", "bots?", "@bots?", ["@bot", "@bots"]],
    ["an alternation", "a|b", "@a|b", ["@a", "@b", "b"]],
    ["a group", "(bot)", "@(bot)", ["@bot"]],
    ["a character class", "[bot]", "@[bot]", ["@b", "@o", "@t"]],
    ["a quantifier", "o{2}", "@o{2}", ["@oo"]],
    ["anchors", "^bot$", "@^bot$", ["@bot"]],
    ["a wildcard run", ".*", "@.*", ["@anything", "@", "anything"]],
    ["a backslash class", "\\w+", "@\\w+", ["@word", "@w"]],
  ])("reads %s in the name literally", (_case, name, mention, lookalikes) => {
    const pattern = mentionPattern(name)

    expect(pattern.test(`hello ${mention} there`)).toBe(true)
    for (const lookalike of lookalikes) {
      expect(pattern.test(`hello ${lookalike} there`), lookalike).toBe(false)
    }
  })

  test("builds a pattern from any name without throwing", () => {
    for (const name of ["(", ")", "[", "\\", "a{", "*", "+?", "$^", "\u{1f916}bot"]) {
      expect(() => mentionPattern(name)).not.toThrow()
    }
  })

  test("answers quickly for a name built to make a naive pattern backtrack", () => {
    const pattern = mentionPattern("(a+)+$")

    expect(pattern.test(`@${"a".repeat(5000)}!`)).toBe(false)
    expect(pattern.test("ping @(a+)+$ now")).toBe(true)
  })
})
