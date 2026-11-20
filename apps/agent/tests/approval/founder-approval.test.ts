import { type Dirent, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"
import { founderResponse } from "#lib/github/founder-response.js"
import { slackConfig } from "#lib/slack/config.js"

/**
 * The trust rule: only a signed-in founder approves anything the agent asks for. Every tool that
 * can stop for a person carries the founder response policy, not eve's default ("only the person
 * whose turn requested the call"), so a founder may approve a write someone else asked for and a
 * collaborator may not approve their own. Each tool is checked through the module the agent mounts,
 * not through the policy alone, and the list of tools is read from the mounts as eve reads them:
 * every module under `tools/` (subfolders too) of the agent and of each station, and every tool a
 * memory slot's provider returns. A tool that gains an `approval` later without the founder
 * response is picked up and fails here, with no list to forget to update. What the scan cannot read
 * fails too, naming it: a module under `tools/` that is not a `defineTool` tool or `disableTool()`
 * (a `defineDynamic` module builds its tools at run time), a station's own stations, `extensions/`.
 *
 * `stationPolicy` and `proposalPolicy` never ask a person (they allow or deny), so for those tools
 * the response policy is defense in depth: it holds if a request policy ever starts to ask.
 */
const FOUNDER = "slack:T0:UFOUNDER"
const OTHER_FOUNDER = "slack:T0:UOTHERFOUNDER"
const MEMBER = "slack:T0:UMEMBER"
// Phase 1: a GitHub-thread answer is never a founder's (the list holds Slack principals), so it
// is always rejected. That fails closed.
const GITHUB_COLLABORATOR = "github:583231"

afterEach(() => {
  vi.unstubAllEnvs()
})

const answer = (decision: "approve" | "deny", principalId: string, requester = FOUNDER) =>
  ({
    auth: {},
    request: {
      callId: "call_test",
      interactionId: "i",
      principal: { principalId: requester, principalType: "user", authenticator: "slack" },
      toolName: "t",
    },
    response: {
      decision,
      principal: {
        attributes: {},
        authenticator: principalId.startsWith("github:") ? "github" : "slack-webhook",
        principalId,
        principalType: "user",
      },
    },
    session: {},
  }) as never

type Responder = (ctx: never) => unknown
const responseOf = (tool: unknown, name: string): Responder => {
  const { approval } = tool as { approval?: { response?: Responder } }
  const response = approval?.response
  if (typeof response !== "function") {
    throw new Error(`${name}: the tool has no response policy`)
  }
  return response
}

const AGENT_DIR = join(import.meta.dirname, "../../agent")

/** eve's module extensions, and what its discovery skips (`discover/filesystem.js`). */
const MODULE = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const DECLARATION = /\.d\.(?:cts|mts|ts)$/
const AUTHORED_TEST = /(?:^|[/\\])__tests__(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]s$/

/**
 * Every module eve mounts under `dir` (a path under `agent/`), walking subfolders as eve does
 * (`tools/github/merge_pr.ts` mounts as `github-merge_pr`). Names are paths under `agent/`
 * without their extension. A missing directory has no modules.
 */
const modulesUnder = (dir: string): string[] => {
  let entries: Dirent[]
  try {
    entries = readdirSync(join(AGENT_DIR, dir), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : modulesUnder(path)
    }
    const mounted =
      entry.isFile() &&
      MODULE.test(entry.name) &&
      !DECLARATION.test(entry.name) &&
      !AUTHORED_TEST.test(entry.name)
    return mounted ? [path] : []
  })
}

/** The agent's root and each station: `""` and `subagents/<station>`. */
const agentRoots = (): string[] => [
  "",
  ...readdirSync(join(AGENT_DIR, "subagents"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `subagents/${entry.name}`),
]

const under = (root: string, dir: string) => (root === "" ? dir : `${root}/${dir}`)

const defaultExportOf = async (file: string): Promise<unknown> =>
  ((await import(pathToFileURL(join(AGENT_DIR, file)).href)) as { default?: unknown }).default

/** eve's brands (`Symbol.for`), on what `defineTool` / `defineWorkflowTool` and `disableTool` make. */
const TOOL_BRANDS = [Symbol.for("eve:tool-brand"), Symbol.for("eve:workflow-tool-brand")]
const DISABLED_TOOL = Symbol.for("eve.disabled-tool")

const isTool = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  TOOL_BRANDS.some((brand) => (value as Record<symbol, unknown>)[brand] === true)

const isDisabledTool = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<symbol, unknown>)[DISABLED_TOOL] === true

const hasApproval = (tool: unknown): boolean =>
  (tool as { approval?: unknown } | undefined)?.approval !== undefined

/**
 * What eve mounts from `agent/` that this test cannot read tools from, so it fails instead of
 * passing without a word: a station's own stations and `extensions/` (their tools are mounted
 * under a namespace) are not scanned, and a `defineDynamic` module under `tools/` builds its tools
 * at run time from a session, so they cannot be listed here either.
 */
const unscannedMounts = (): string[] =>
  agentRoots().flatMap((root) =>
    ["extensions", "subagents"]
      // The root's own `subagents/` is the list of stations; a station's is a nested station.
      .filter((dir) => !(root === "" && dir === "subagents"))
      .filter((dir) => existsSync(join(AGENT_DIR, under(root, dir))))
      .map(
        (dir) =>
          `${under(root, dir)}/ is mounted by eve but this test does not read it: extend the scan`,
      ),
  )

/** The context eve gives a memory provider's `tools()` (`memory/definition.js`), as a stub. */
const memoryToolsContext = {
  abortSignal: new AbortController().signal,
  channel: { name: "test" },
  memory: { scope: { kind: "org" }, slot: "test" },
  session: { auth: { attributes: {}, principalId: FOUNDER }, id: "session-test" },
} as never

interface Mounted {
  /** Every tool that stops for a person, by where it is mounted from. */
  cases: [string, unknown][]
  /** What the scan could not check: each is a reason to fail. */
  problems: string[]
}

/**
 * Every mounted tool that stops for a person: each module under every `tools/` (the root's and each
 * station's, subfolders too), and every tool each memory slot's provider returns (`memory/*` and
 * each station's), by where it is mounted from. A module it cannot classify, or a mount it does not
 * read, is a problem, never a silent skip.
 */
const mounted = async (): Promise<Mounted> => {
  const cases: [string, unknown][] = []
  const problems = unscannedMounts()
  for (const root of agentRoots()) {
    for (const file of modulesUnder(under(root, "tools"))) {
      const tool = await defaultExportOf(file)
      if (!isTool(tool) && !isDisabledTool(tool)) {
        problems.push(
          `unrecognised tool module ${file}: cannot check its approval policy; ` +
            "add handling or a case (a defineDynamic module builds its tools at run time)",
        )
      } else if (hasApproval(tool)) {
        cases.push([file.replace(MODULE, ""), tool])
      }
    }
    // A slot is `memory/<slot>.ts` or `memory.ts`: the module's default is `defineMemory`'s
    // definition, whose provider's `tools()` returns the slot's tools by name.
    const slots = [
      ...modulesUnder(under(root, "memory")),
      ...readdirSync(join(AGENT_DIR, root), { withFileTypes: true })
        .filter((entry) => entry.isFile() && MODULE.test(entry.name))
        .filter((entry) => entry.name.replace(MODULE, "") === "memory")
        .map((entry) => under(root, entry.name)),
    ]
    for (const file of slots) {
      const slot = (await defaultExportOf(file)) as {
        provider?: { tools?: (ctx: never) => unknown }
      }
      if (slot?.provider === undefined) {
        problems.push(`unrecognised memory module ${file}: it has no provider to read tools from`)
        continue
      }
      if (typeof slot.provider.tools !== "function") {
        continue // a provider with no tools has nothing to check
      }
      const tools = (await slot.provider.tools(memoryToolsContext)) as Record<
        string,
        unknown
      > | null
      if (tools === null || tools === undefined || Object.keys(tools).length === 0) {
        problems.push(
          `memory module ${file}: tools() returned none without a session; ` +
            "the scan cannot tell whether it has approval tools: extend the test",
        )
        continue
      }
      for (const [name, tool] of Object.entries(tools)) {
        if (hasApproval(tool)) {
          cases.push([`${file.replace(MODULE, "")} ${name}`, tool])
        }
      }
    }
  }
  return { cases, problems }
}

describe("every approval tool answers to a listed founder only", async () => {
  const { cases, problems } = await mounted()

  test("every mounted module and directory could be checked", () => {
    expect(problems).toEqual([])
  })

  test("the mounted tools were found: the four shells and every tool known to ask", () => {
    // A scan that found nothing would pass everything below; these are the tools known to ask.
    expect(cases.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "tools/bash",
        "subagents/analyst/tools/bash",
        "subagents/implementer/tools/bash",
        "subagents/reviewer/tools/bash",
        "tools/run_analyst",
        "tools/run_classifier",
        "tools/run_implementer",
        "tools/run_researcher",
        "tools/run_reviewer",
        "tools/triage_work_item",
        "tools/request_bigger_model",
        "memory/hq propose_entry",
      ]),
    )
  })

  test.each(cases)(
    "%s: a listed founder is accepted, even for a request someone else made",
    async (name, tool) => {
      vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", `${FOUNDER}, ${OTHER_FOUNDER}`)
      const response = responseOf(tool, name)
      expect(await response(answer("approve", FOUNDER))).toEqual({ status: "allowed" })
      // A different listed founder than the one whose turn asked may approve it.
      expect(await response(answer("approve", OTHER_FOUNDER, FOUNDER))).toEqual({
        status: "allowed",
      })
      expect(await response(answer("approve", FOUNDER, MEMBER))).toEqual({ status: "allowed" })
    },
  )

  test.each(cases)(
    "%s: a non-founder is refused, whoever asked, and the request stays open",
    async (name, tool) => {
      vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", FOUNDER)
      const response = responseOf(tool, name)
      for (const principal of [
        MEMBER,
        "slack:T9:UFOUNDER",
        GITHUB_COLLABORATOR,
        "eve:app",
        "local-dev",
      ]) {
        expect(await response(answer("approve", principal, principal)), principal).toMatchObject({
          status: "rejected",
        })
      }
      // The requester themselves is not special either.
      expect(await response(answer("approve", MEMBER, MEMBER))).toMatchObject({
        reason: expect.stringMatching(/^Only a founder can approve/),
        status: "rejected",
      })
    },
  )

  test.each(cases)("%s: with no founders listed nobody approves", async (name, tool) => {
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "")
    const response = responseOf(tool, name)
    expect(await response(answer("approve", FOUNDER))).toMatchObject({ status: "rejected" })
  })

  test.each(cases)("%s: anyone may dismiss, as founderOnly already allows", async (name, tool) => {
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", FOUNDER)
    expect(await responseOf(tool, name)(answer("deny", MEMBER))).toEqual({ status: "allowed" })
  })

  test("the founder response is the one shared policy, not a copy per tool", async () => {
    for (const [name, tool] of cases.filter(([n]) => n !== "tools/request_bigger_model")) {
      expect(responseOf(tool, name), name).toBe(founderResponse)
    }
  })
})

describe("the Slack channel's answers are founder-only too", () => {
  const auth = (principalId: string) => ({
    attributes: {},
    authenticator: "slack-webhook",
    principalId,
    principalType: "user",
  })

  test("a listed founder from an allowed workspace gets through; a member or an outsider does not", () => {
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", FOUNDER)
    vi.stubEnv("SLACK_ALLOWED_TEAM_IDS", "T0")
    const onAnswers = (principalId: string) =>
      slackConfig.onAnswers({ defaultAuth: auth(principalId) } as never)
    expect(onAnswers(FOUNDER)).toMatchObject({ auth: { principalId: FOUNDER } })
    expect(onAnswers(MEMBER)).toBeNull()
    expect(onAnswers("slack:T9:UFOUNDER")).toBeNull()
  })
})
