import { z } from "zod"

import {
  attemptKind,
  headSha,
  idRef,
  itemRef,
  noteText,
  workBoard as workBoardSchema,
  workItemDetail as workItemDetailSchema,
  workState,
} from "../../../src/operations/work-schemas"
import { deriveCardState, parseWorkRef } from "../../../src/work/machine"
import type {
  AttemptView,
  NeedsYou,
  QuestionView,
  WorkItemDetail,
  WorkItemSummary,
} from "../api/schemas"
import type { FakeHqState } from "./fake-hq"

// The work pipeline's half of the fake of hq: the 11 routes the app calls (the board, the list, one
// item and the eight founder decisions of hq's work-founder.ts), with hq's own order of refusals,
// hq's own input checks (built from the same zod pieces), and the coherent change each decision
// makes to the board, the item, the question and the status counts. Every value a decision sets
// was read from a real hq (web-contract.test.ts compares them row by row), not guessed.
//
// The agent's operations (record_signal, start_attempt, record_pull_request ...) are NOT here: the
// app has no client method for them, so a call to one is a 404 and a violation, like any path the
// app has no business calling.

type Env = {
  state: FakeHqState
  json: (status: number, body: unknown) => Response
  appError: (status: number, code: string, message: string, hint?: string) => Response
  /** Record a fixture or a call hq would never see, and throw (the client would read it as unreachable). */
  violate: (message: string) => never
}

export interface WorkRoute {
  /** A decision: it needs a trusted Origin and a JSON object body. */
  write: boolean
  run: (search: URLSearchParams, body: Record<string, unknown>) => Response
}

/** hq's limits (data/work-items.ts LIST_MAX_LIMIT, QUERY_MAX_CHARS; work/constants.ts). */
const LIST_MAX_LIMIT = 100
const QUERY_MAX_CHARS = 200
const PAYLOAD_MAX_BYTES = 20_000
const SUMMARY_MAX_CHARS = 300
// Every path of the pipeline, the agent's included (a call to those is a bug in the app too).
const WORK_PREFIXES = [
  "/v1/work/",
  "/v1/work-items",
  "/v1/questions/",
  "/v1/signals",
  "/v1/pull-requests",
  "/v1/attempts",
]

export const isWorkPath = (path: string): boolean =>
  WORK_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))

const repoPattern = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/name")
  .max(200)
const inputs = {
  list: z.object({
    state: workState.optional(),
    query: z.string().max(QUERY_MAX_CHARS).optional(),
    dedupeKey: z.string().max(200).optional(),
    pullRequestNumber: z.coerce.number().int().min(1).optional(),
    repo: z.string().max(200).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  }),
  get: z.object({ itemId: itemRef }),
  create: z.object({
    title: z.string().min(1).max(300),
    body: z.string().max(PAYLOAD_MAX_BYTES).optional(),
    repo: repoPattern,
  }),
  request: z.object({ itemId: itemRef, kind: attemptKind, instructions: noteText.optional() }),
  answer: z.object({
    questionId: idRef("question"),
    optionId: z.string().min(1).max(100),
    note: noteText.optional(),
  }),
  approve: z.object({ itemId: itemRef, headSha, note: noteText.optional() }),
  note: z.object({ itemId: itemRef, note: noteText.optional() }),
  retry: z.object({ itemId: itemRef, note: noteText.min(1) }),
}

/** Every object key path of a JSON value, arrays flattened (the contract test's own). */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`))
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [
    `${prefix}.${key}`,
    ...keyPaths(child, `${prefix}.${key}`),
  ])
}
const keySet = (value: unknown) => [...new Set(keyPaths(value))].sort().join("\n")

const inFlight = (state: WorkItemSummary["state"]) =>
  state !== "done" && state !== "reopened" && state !== "stopped"
const COLUMN_OF: Record<WorkItemSummary["state"], string> = {
  signal: "triage",
  triage: "triage",
  plan: "fixing",
  attempt: "fixing",
  review: "in_review",
  deploy: "verifying",
  verify: "verifying",
  done: "done_today",
  reopened: "done_today",
  stopped: "done_today",
}
const BOARD_COLUMN_CAP = 30
const CURSOR_HINT =
  "Pass nextCursor from the previous page unchanged, or omit cursor to start from the first page."

/** hq's order of a column: what waits for a founder first (the longest wait first), then the newest. */
const byWaitingThenNewest = (a: WorkItemSummary, b: WorkItemSummary): number => {
  const aw = a.waitingSince === null ? null : Date.parse(a.waitingSince)
  const bw = b.waitingSince === null ? null : Date.parse(b.waitingSince)
  if (aw !== null && bw !== null && aw !== bw) return aw - bw
  if ((aw === null) !== (bw === null)) return aw === null ? 1 : -1
  return Date.parse(b.stateChangedAt) - Date.parse(a.stateChangedAt) || b.number - a.number
}

/**
 * What `get_factory_status.work` says about a board and its items, as hq counts it
 * (data/status.ts): the board's own numbers, and EVERY open question of an item in flight, also one
 * the item's card hides behind a merge approval (so not the needs-you cards).
 */
export function workCountsOf(
  board: FakeHqState["workBoard"],
  items: FakeHqState["workItems"],
): NonNullable<FakeHqState["factoryStatus"]["work"]> {
  return {
    inFlight: board.stats.inFlight,
    needsYou: board.stats.needsYou,
    pendingMergeApprovals: board.needsYou.filter((n) => n.kind === "merge_approval").length,
    openQuestions: Object.values(items)
      .filter((i) => inFlight(i.state))
      .reduce((sum, i) => sum + i.questions.filter((q) => q.status === "open").length, 0),
  }
}

export function workRoutes(env: Env) {
  const { state, json, appError } = env
  let seq = 0
  const uuid = () => `00000000-0000-4000-8000-${(0xf00000000000 + ++seq).toString(16)}`
  const nowIso = () => state.workBoard.now
  // The rows hq keeps for a pull request and a window have ids the views do not carry; the events
  // name them, so the fake gives each item one of each, the same every time.
  const hidden = new Map<string, string>()
  const hiddenId = (kind: "pr" | "window", item: WorkItemDetail) => {
    const key = `${kind}:${item.id}:${item.cycle}`
    if (!hidden.has(key)) hidden.set(key, uuid())
    return hidden.get(key) as string
  }
  /** An event hq's own system writes. */
  const bySystem = { actorType: "system", actorId: "hq" } as const

  /** What hq answers for an input that fails its schema: BAD_REQUEST with zod's own words, nothing looked up. */
  const invalid = (error: z.ZodError) => appError(400, "BAD_REQUEST", z.prettifyError(error))
  const bad = (message: string) => appError(400, "BAD_REQUEST", message)
  const notFound = (what: string) => appError(404, "NOT_FOUND", `${what} not found`)

  /** The fixtures the fake serves must be what hq returns: the shared schema, and no extra key. */
  function strict(record: boolean) {
    const fail = (message: string): never => {
      if (record) return env.violate(message)
      throw new Error(message)
    }
    const board = workBoardSchema.safeParse(state.workBoard)
    if (!board.success) fail(`workBoard is not what hq returns: ${board.error.message}`)
    else if (keySet(board.data) !== keySet(state.workBoard)) {
      fail("workBoard carries a key hq does not send")
    }
    const keys = ["triage", "fixing", "in_review", "verifying", "done_today"]
    if (state.workBoard.columns.map((c) => c.key).join() !== keys.join()) {
      fail("workBoard.columns must be the five columns in hq's order")
    }
    for (const [id, item] of Object.entries(state.workItems)) {
      const parsed = workItemDetailSchema.safeParse(item)
      if (!parsed.success) fail(`workItems[${id}] is not what hq returns: ${parsed.error.message}`)
      else if (keySet(parsed.data) !== keySet(item))
        fail(`workItems[${id}] carries a key hq does not send`)
      if (item.id !== id) fail(`workItems is keyed by the item's id: ${id} holds ${item.id}`)
      if (item.displayId !== `FAC-${item.number}`)
        fail(`workItems[${id}].displayId is not FAC-<number>`)
    }
  }

  const find = (ref: string): WorkItemDetail | undefined => {
    const parsed = parseWorkRef(ref)
    if (parsed?.kind === "id") {
      const id = Object.keys(state.workItems).find(
        (k) => k.toLowerCase() === parsed.id.toLowerCase(),
      )
      return id ? state.workItems[id] : undefined
    }
    if (parsed?.kind === "number") {
      return Object.values(state.workItems).find((i) => i.number === parsed.number)
    }
    return undefined
  }
  const findQuestion = (id: string) => {
    for (const item of Object.values(state.workItems)) {
      const question = item.questions.find((q) => q.id.toLowerCase() === id.toLowerCase())
      if (question) return { item, question }
    }
    return undefined
  }

  // ---- what a decision does to the item, the board and the counts ------------------------------

  const summaryOf = (item: WorkItemDetail): WorkItemSummary => ({
    id: item.id,
    number: item.number,
    displayId: item.displayId,
    title: item.title,
    repo: item.repo,
    source: item.source,
    state: item.state,
    cycle: item.cycle,
    card: item.card,
    attention: item.attention,
    waitingSince: item.waitingSince,
    attempts: item.attempts,
    pullRequest: item.pullRequest
      ? {
          number: item.pullRequest.number,
          url: item.pullRequest.url,
          state: item.pullRequest.state,
          isDraft: item.pullRequest.isDraft,
        }
      : null,
    summary: item.summary,
    createdAt: item.createdAt,
    stateChangedAt: item.stateChangedAt,
  })

  /** What a founder may do next, from the item as it now stands (hq's `actions`). */
  function actionsOf(item: WorkItemDetail): WorkItemDetail["actions"] {
    const open = item.attemptList.some((a) => a.status === "requested" || a.status === "running")
    const budgetLeft = item.attempts.limit === null || item.attempts.used < item.attempts.limit
    return {
      canStop: inFlight(item.state),
      canReopen: item.state === "verify" || item.state === "done" || item.state === "stopped",
      canRevert:
        item.pullRequest?.state === "merged" &&
        (item.state === "deploy" || item.state === "verify" || item.state === "done"),
      canRetry: item.attention === "attempt_budget",
      canRequestAttempt:
        state.workBoard.dispatch === "claim" &&
        ["triage", "plan", "attempt", "review"].includes(item.state) &&
        !open &&
        budgetLeft,
    }
  }

  const stagesAt = (stage: string | null): WorkItemDetail["stages"] =>
    (["signal", "triage", "plan", "attempt", "review", "deploy", "verify"] as const).map(
      (name, i, all) => {
        const at = stage === null ? all.length : all.indexOf(stage as (typeof all)[number])
        return { stage: name, status: i < at ? "done" : i === at ? "now" : "todo" }
      },
    )

  function event(
    item: WorkItemDetail,
    kind: WorkItemDetail["events"][number]["kind"],
    summary: string,
    extra: Partial<WorkItemDetail["events"][number]> = {},
  ) {
    item.events = [
      {
        id: uuid(),
        at: nowIso(),
        kind,
        fromState: null,
        toState: null,
        actorType: "founder",
        actorId: state.user.id,
        reason: null,
        note: null,
        detail: null,
        cycle: item.cycle,
        summary,
        ...extra,
      },
      ...item.events,
    ]
  }

  function moved(
    item: WorkItemDetail,
    to: WorkItemSummary["state"],
    reason: string,
    note: string | null,
    detail: Record<string, unknown> | null = null,
  ) {
    const from = item.state
    event(item, "transition", `Moved from ${from} to ${to} (${reason.replaceAll("_", " ")}).`, {
      fromState: from,
      toState: to,
      reason,
      note,
      detail,
    })
    item.state = to
    item.stateChangedAt = nowIso()
  }

  /** Bring the board, the counts and the status in step with one item that just changed. */
  function sync(before: WorkItemDetail, after: WorkItemDetail, removed: NeedsYou["kind"][] = []) {
    after.actions = actionsOf(after)
    const board = state.workBoard
    for (const column of board.columns) {
      const had = column.items.some((i) => i.id === after.id)
      column.items = column.items.filter((i) => i.id !== after.id)
      if (had) column.count -= 1
    }
    const target = board.columns.find((c) => c.key === COLUMN_OF[after.state])
    if (target) {
      // `count` is the true total, the cards are at most the cap.
      target.items = [...target.items, summaryOf(after)]
        .sort(byWaitingThenNewest)
        .slice(0, BOARD_COLUMN_CAP)
      target.count += 1
    }
    board.needsYou = board.needsYou.filter(
      (n) => !(n.itemId === after.id && (removed.length === 0 || removed.includes(n.kind))),
    )
    const surfaced = questionNeed(after)
    if (surfaced && !board.needsYou.some((n) => n.itemId === after.id)) {
      board.needsYou = [...board.needsYou, surfaced].sort(
        (a, b) =>
          Date.parse(a.since) - Date.parse(b.since) ||
          Number(a.displayId.slice(4)) - Number(b.displayId.slice(4)),
      )
    }
    const stats = board.stats
    // A merge counts as resolved today while it is the item's current pull request: a new cycle
    // (a reopened stopped item) starts without one.
    const mergedToday = (item: WorkItemDetail) =>
      item.pullRequest?.state === "merged" &&
      item.pullRequest.mergedAt?.slice(0, 10) === board.now.slice(0, 10)
    stats.resolvedToday += Number(mergedToday(after)) - Number(mergedToday(before))
    stats.inFlight += Number(inFlight(after.state)) - Number(inFlight(before.state))
    stats.watching += Number(after.state === "verify") - Number(before.state === "verify")
    stats.reopened += Number(after.state === "reopened") - Number(before.state === "reopened")
    stats.needsYou = board.needsYou.length
    const oldest = board.needsYou.map((n) => Date.parse(n.since)).sort((a, b) => a - b)[0]
    stats.oldestWaitingMinutes =
      oldest === undefined ? null : Math.floor((Date.parse(board.now) - oldest) / 60_000)
    if (state.factoryStatus.work) {
      state.factoryStatus = {
        ...state.factoryStatus,
        work: workCountsOf(board, state.workItems),
      }
    }
  }

  /**
   * The card of an item nothing waits on a founder for: a requested attempt, else hq's own
   * `deriveCardState` (the pure function the board uses) over what the item shows.
   */
  function idleCard(item: WorkItemDetail): WorkItemDetail["card"] {
    if (item.attemptList.some((a) => a.status === "requested")) {
      return {
        label: "queued",
        tone: "dim",
        detail: "attempt requested \u00b7 waits to be claimed",
      }
    }
    const running = item.attemptList.find((a) => a.status === "running")
    const newestFix = item.attemptList
      .filter((a) => a.kind === "fix" && a.cycle === item.cycle && a.status === "finished")
      .sort((a, b) => b.number - a.number)[0]
    return deriveCardState({
      state: item.state,
      pendingMergeApproval: false,
      openQuestion: false,
      attemptsUsed: item.attempts.used,
      attemptLimit: item.attempts.limit,
      activeAttempt: running ? "fresh" : "none",
      newestFixResult: newestFix?.result ?? null,
      attention: null,
      activeKind: running?.kind ?? null,
      windowEndsAt: item.window ? new Date(item.window.endsAt) : null,
      now: new Date(state.workBoard.now),
    })
  }

  /**
   * What waits for a founder is derived, never stored: once a decision clears one need, an open
   * question the card was hiding behind it (a merge approval) comes forward, the oldest first.
   */
  const clearAttention = (item: WorkItemDetail) => {
    const open = item.questions
      .filter((q) => q.status === "open")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (open && inFlight(item.state)) {
      item.attention = "agent_question"
      item.waitingSince = open.createdAt
      item.card = { label: "asking you", tone: "amber", detail: "waits for your answer" }
      return
    }
    item.attention = null
    item.waitingSince = null
    item.card = idleCard(item)
  }

  /** The Needs you card of an item whose attention is an open question. */
  function questionNeed(item: WorkItemDetail): NeedsYou | null {
    const open = item.questions
      .filter((q) => q.status === "open")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    if (!open || item.attention !== "agent_question") return null
    return {
      kind: "agent_question",
      itemId: item.id,
      displayId: item.displayId,
      title: item.title,
      reason: "The agent asked a question and waits for your answer.",
      since: open.createdAt,
      question: {
        questionId: open.id,
        prompt: open.prompt,
        options: open.options,
        defaultOptionId: open.defaultOptionId,
      },
    }
  }

  // ---- the routes ---------------------------------------------------------------------------------

  function listItems(search: URLSearchParams): Response {
    const parsed = inputs.list.safeParse(Object.fromEntries(search))
    if (!parsed.success) return invalid(parsed.error)
    const q = parsed.data
    let offset = 0
    if (q.cursor !== undefined && q.cursor !== "") {
      offset = Number(safeAtob(q.cursor))
      if (!Number.isInteger(offset) || offset < 0) {
        return appError(400, "BAD_REQUEST", "Invalid cursor", CURSOR_HINT)
      }
    }
    const needle = q.query?.toLowerCase()
    const all = Object.values(state.workItems)
      .filter((i) => q.state === undefined || i.state === q.state)
      .filter((i) => q.dedupeKey === undefined || state.workDedupeKeys[i.id] === q.dedupeKey)
      .filter(
        (i) => q.pullRequestNumber === undefined || i.pullRequest?.number === q.pullRequestNumber,
      )
      .filter((i) => q.repo === undefined || i.repo === q.repo)
      .filter(
        (i) =>
          needle === undefined ||
          [i.title, i.displayId, i.signal?.summary ?? "", ...i.attemptList.flatMap((a) => a.files)]
            .join("\n")
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number)
    const items = all.slice(offset, offset + q.limit).map(summaryOf)
    const next = offset + q.limit
    return json(200, { items, nextCursor: next < all.length ? btoa(String(next)) : null })
  }

  function create(body: Record<string, unknown>): Response {
    const parsed = inputs.create.safeParse(body)
    if (!parsed.success) return invalid(parsed.error)
    if (parsed.data.title.trim() === "") return bad("title must not be empty")
    const { title, body: text, repo } = parsed.data
    const number = Math.max(0, ...Object.values(state.workItems).map((i) => i.number)) + 1
    const id = uuid()
    const summary = text
      ? firstChars(text.replace(/\s+/g, " ").trim(), SUMMARY_MAX_CHARS) || title
      : title
    const key = `manual:${uuid()}`
    const at = nowIso()
    const item: WorkItemDetail = {
      id,
      number,
      displayId: `FAC-${number}`,
      title,
      repo,
      source: "manual",
      state: "triage",
      cycle: 1,
      card: { label: "queued", tone: "dim", detail: "waits for a founder to start" },
      attention: null,
      waitingSince: null,
      attempts: { used: 0, limit: null, running: false },
      pullRequest: null,
      summary,
      createdAt: at,
      // hq writes the ingest transition a millisecond after the item: the board sorts by it.
      stateChangedAt: new Date(Date.parse(at) + 1).toISOString(),
      signal: {
        id: uuid(),
        source: "manual",
        externalId: key,
        url: null,
        urlChecked: false,
        summary,
        occurrences: 1,
        firstSeenAt: at,
        lastSeenAt: at,
        evidence: text ? text.slice(0, PAYLOAD_MAX_BYTES) : null,
      },
      stages: stagesAt("triage"),
      contract: [],
      attemptList: [],
      questions: [],
      mergeApproval: null,
      window: null,
      founderNotes: [],
      events: [],
      truncated: { attempts: false, questions: false, events: false },
      actions: {
        canStop: true,
        canReopen: false,
        canRevert: false,
        canRetry: false,
        canRequestAttempt: false,
      },
    }
    event(item, "signal_attached", "A signal was attached.", {
      detail: { source: "manual", signalId: item.signal?.id, externalId: key },
    })
    event(item, "transition", "Moved from signal to triage (ingested).", {
      fromState: "signal",
      toState: "triage",
      actorType: "system",
      actorId: "hq",
      reason: "ingested",
    })
    state.workItems[id] = item
    state.workDedupeKeys[id] = key
    if (!state.workBoard.repos.includes(repo)) {
      state.workBoard.repos = [...state.workBoard.repos, repo].sort()
    }
    // Not in flight before it existed: the delta then counts it.
    sync({ ...item, state: "done" }, item)
    return json(200, { itemId: id, displayId: item.displayId })
  }

  /**
   * hq's start rules for a requested attempt, in its order: the state a kind may start from, one
   * active attempt, then the fix budget of the cycle. `null` when the request is allowed.
   */
  function refusal(
    item: WorkItemDetail,
    kind: AttemptView["kind"],
  ): { message: string; hint?: string } | null {
    const allowed =
      item.state === "plan" ||
      (item.state === "triage" && kind === "investigate") ||
      ((item.state === "review" || item.state === "attempt") && kind === "fix")
    if (!allowed) {
      return {
        message: `A ${kind} attempt cannot start while the work item is in ${item.state}.`,
        ...(item.state === "triage" && kind === "fix"
          ? { hint: "Investigate first: a fix starts from plan, attempt or review." }
          : {}),
      }
    }
    if (item.attemptList.some((a) => a.status === "requested" || a.status === "running")) {
      return {
        message: "An attempt is already running",
        hint: "Wait for it to finish, or for its lease to expire.",
      }
    }
    if (
      kind === "fix" &&
      item.attempts.limit !== null &&
      item.attempts.used >= item.attempts.limit
    ) {
      return {
        message: `This work item has used its ${item.attempts.limit} fix attempts for this cycle.`,
      }
    }
    return null
  }

  function requestAttempt(body: Record<string, unknown>, itemId: string): Response {
    const parsed = inputs.request.safeParse({ ...body, itemId })
    if (!parsed.success) return invalid(parsed.error)
    // hq refuses in label mode before it looks the item up.
    if (state.workBoard.dispatch === "label") {
      return appError(
        400,
        "BAD_REQUEST",
        "This factory starts attempts from the agent:build label",
        "Add the `agent:build` label to the issue to start the agent (if it already has the label, " +
          "remove it and add it again: GitHub starts a run only when the label is added).",
      )
    }
    const item = find(parsed.data.itemId)
    if (!item) return notFound("Work item")
    const before = structuredClone(item)
    const refused = refusal(item, parsed.data.kind)
    if (refused) return appError(409, "CONFLICT", refused.message, refused.hint)
    const view = requested(item, parsed.data.kind, parsed.data.instructions ?? null)
    if (parsed.data.instructions) {
      item.founderNotes = [
        ...item.founderNotes,
        { at: nowIso(), kind: "request", text: parsed.data.instructions },
      ]
    }
    event(item, "attempt_requested", `Attempt ${view.number} requested.`, {
      detail: {
        attemptId: view.id,
        number: view.number,
        kind: view.kind,
        origin: "founder_request",
      },
    })
    clearAttention(item)
    sync(before, item)
    return json(200, view)
  }

  /** A requested attempt on the item (hq's `requestAttempt`), as the view hq answers. */
  function requested(item: WorkItemDetail, kind: AttemptView["kind"], instructions: string | null) {
    const view: AttemptView = {
      id: uuid(),
      number: Math.max(0, ...item.attemptList.map((a) => a.number)) + 1,
      cycle: item.cycle,
      kind,
      status: "requested",
      result: null,
      requestedBy: state.user.id,
      instructions,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      files: [],
      note: null,
      branch: null,
      reviewer: null,
      runId: null,
      sessionId: null,
      externalRef: null,
      leaseExpiresAt: null,
      costUsd: null,
      costEstimated: false,
      endReason: null,
    }
    item.attemptList = [...item.attemptList, view]
    return view
  }

  function answer(body: Record<string, unknown>, questionId: string): Response {
    const parsed = inputs.answer.safeParse({ ...body, questionId })
    if (!parsed.success) return invalid(parsed.error)
    const found = findQuestion(parsed.data.questionId)
    if (!found) return notFound("Question")
    const { item, question } = found
    if (question.status !== "open") {
      return appError(409, "CONFLICT", `This question is already ${question.status}.`)
    }
    const chosen = question.options.find((o) => o.id === parsed.data.optionId)
    if (!chosen) {
      return appError(400, "BAD_REQUEST", "optionId is not one of the question's options")
    }
    const before = structuredClone(item)
    const answered: QuestionView = {
      ...question,
      status: "answered",
      answeredOptionId: chosen.id,
      answeredBy: state.user.id,
      answeredAt: nowIso(),
    }
    item.questions = item.questions.map((q) => (q.id === question.id ? answered : q))
    if (parsed.data.note) {
      item.founderNotes = [
        ...item.founderNotes,
        { at: nowIso(), kind: "answer", text: parsed.data.note },
      ]
    }
    event(item, "question_answered", "A founder answered a question.", {
      note: parsed.data.note ?? null,
      detail: { questionId: question.id, optionId: chosen.id },
    })
    clearAttention(item)
    // Where hq dispatches, an answer also requests the attempt it asks for (never a default). If
    // that request is refused the answer stays recorded, the history says why, and the reply is
    // the refusal.
    let refused: ReturnType<typeof refusal> = null
    if (state.workBoard.dispatch === "claim") {
      const newest = item.attemptList
        .filter((a) => a.cycle === item.cycle)
        .sort((a, b) => b.number - a.number)[0]
      const kind = newest?.kind ?? "investigate"
      refused = refusal(item, kind)
      if (refused) {
        event(item, "attempt_request_refused", "No attempt was requested after the answer.", {
          reason: "conflict",
          note: refused.message,
          detail: { questionId: question.id, optionId: chosen.id, kind },
          at: new Date(Date.parse(nowIso()) + 1).toISOString(),
        })
      } else {
        const text = `A founder answered: ${chosen.label}${parsed.data.note ? `\n\n${parsed.data.note}` : ""}`
        const instructions = firstChars(text, 2000)
        const view = requested(item, kind, instructions)
        item.founderNotes = [
          ...item.founderNotes,
          { at: nowIso(), kind: "request", text: instructions },
        ]
        event(item, "attempt_requested", `Attempt ${view.number} requested.`, {
          detail: {
            attemptId: view.id,
            number: view.number,
            kind: view.kind,
            origin: "founder_request",
          },
        })
      }
      item.card = idleCard(item)
    }
    sync(before, item, ["agent_question"])
    if (refused) return appError(409, "CONFLICT", refused.message, refused.hint)
    return json(200, answered)
  }

  function approve(body: Record<string, unknown>, itemId: string): Response {
    const parsed = inputs.approve.safeParse({ ...body, itemId })
    if (!parsed.success) return invalid(parsed.error)
    const item = find(parsed.data.itemId)
    if (!item) return notFound("Work item")
    const before = structuredClone(item)
    const sha = parsed.data.headSha.toLowerCase()
    if (item.state !== "review") {
      return appError(
        409,
        "CONFLICT",
        `A merge can be approved only while the work item is in review, not in ${item.state}.`,
      )
    }
    const pr = item.pullRequest
    if (!pr || pr.state !== "open") {
      return appError(409, "CONFLICT", "The pull request is not open.")
    }
    const approval = item.mergeApproval
    const hint = "Read the work item again and approve the head it shows now."
    if (!approval || approval.status !== "pending") {
      if (sha !== pr.headSha) {
        return appError(409, "CONFLICT", "The pull request changed since you looked", hint)
      }
      return appError(
        409,
        "CONFLICT",
        approval?.status === "approved" && approval.headSha === sha
          ? "This merge is already approved."
          : "No merge approval is waiting for this pull request.",
        "Read the work item again.",
      )
    }
    if (approval.headSha !== sha || pr.headSha !== sha) {
      return appError(409, "CONFLICT", "The pull request changed since you looked", hint)
    }
    item.mergeApproval = {
      ...approval,
      status: "approved",
      decidedBy: state.user.id,
      decidedAt: nowIso(),
      note: parsed.data.note ?? null,
    }
    event(item, "merge_approved", "Merge approved by a founder.", {
      note: parsed.data.note ?? null,
      detail: {
        approvalId: approval.id,
        headSha: sha,
        pullRequestId: hiddenId("pr", item),
        pullRequestNumber: pr.number,
      },
    })
    clearAttention(item)
    sync(before, item, ["merge_approval"])
    return json(200, { status: "approved", headSha: sha, pullRequestUrl: pr.url })
  }

  const cannotMove = (from: string, to: string) =>
    appError(409, "CONFLICT", `A work item cannot move from ${from} to ${to}.`)

  /** A running window ends (hq's system closes it and says so). */
  function endWindow(item: WorkItemDetail, status: "stopped") {
    if (item.window?.status !== "running") return
    item.window = { ...item.window, status, remainingMinutes: null }
    event(item, "window_closed", `The verification window closed (${status}).`, {
      ...bySystem,
      detail: { windowId: hiddenId("window", item), status },
    })
  }

  function stop(body: Record<string, unknown>, itemId: string): Response {
    const parsed = inputs.note.safeParse({ ...body, itemId })
    if (!parsed.success) return invalid(parsed.error)
    const item = find(parsed.data.itemId)
    if (!item) return notFound("Work item")
    if (!inFlight(item.state)) return cannotMove(item.state, "stopped")
    const before = structuredClone(item)
    const open = item.questions.filter((q) => q.status === "open")
    moved(
      item,
      "stopped",
      "stopped",
      parsed.data.note ?? null,
      open.length === 0 ? null : { withdrawnQuestionIds: open.map((q) => q.id) },
    )
    endWindow(item, "stopped")
    // A pending or approved merge approval on an open pull request is voided.
    const approval = item.mergeApproval
    if (
      item.pullRequest?.state === "open" &&
      approval &&
      ["pending", "approved"].includes(approval.status)
    ) {
      item.mergeApproval = { ...approval, status: "void" }
      event(item, "merge_approval_void", "Merge approval voided (stopped).", {
        ...bySystem,
        reason: "stopped",
        detail: {
          approvalId: approval.id,
          headSha: approval.headSha,
          pullRequestId: hiddenId("pr", item),
          was: approval.status,
        },
      })
    }
    item.questions = item.questions.map((q) =>
      q.status === "open" ? { ...q, status: "withdrawn" } : q,
    )
    for (const a of item.attemptList.filter((x) => x.status === "requested")) {
      event(item, "attempt_abandoned", `Attempt ${a.number} abandoned (stopped).`, {
        ...bySystem,
        detail: { attemptId: a.id, number: a.number, kind: a.kind, reason: "stopped" },
      })
    }
    item.attemptList = item.attemptList.map((a) =>
      a.status === "requested"
        ? {
            ...a,
            status: "finished",
            result: "abandoned",
            finishedAt: nowIso(),
            endReason: "stopped",
          }
        : a,
    )
    item.attention = null
    item.waitingSince = null
    item.card = { label: "stopped", tone: "dim", detail: "stopped by a founder" }
    sync(before, item)
    return json(200, { state: "stopped" })
  }

  function reopen(body: Record<string, unknown>, itemId: string): Response {
    const parsed = inputs.note.safeParse({ ...body, itemId })
    if (!parsed.success) return invalid(parsed.error)
    const item = find(parsed.data.itemId)
    if (!item) return notFound("Work item")
    const to = item.state === "stopped" ? "triage" : "reopened"
    if (!["verify", "done", "stopped"].includes(item.state))
      return cannotMove(item.state, "reopened")
    const before = structuredClone(item)
    // The move into triage adds 1 to the cycle, and the event it writes is the new cycle's.
    if (to === "triage") item.cycle += 1
    moved(item, to, "reopened", parsed.data.note ?? null)
    endWindow(item, "stopped")
    item.stages = stagesAt("triage")
    if (to === "triage") {
      // What hq scopes to a cycle starts empty again: the contract, the verification window, the
      // current pull request and its merge approval, and the count of fix attempts used. The
      // attempts themselves, the questions and the notes stay on the item; the limit is the item's.
      item.contract = []
      item.window = null
      item.pullRequest = null
      item.mergeApproval = null
      // (a running attempt of the old cycle is left alone: hq cannot reach the agent)
      item.attempts = { ...item.attempts, used: 0 }
    }
    item.card =
      to === "triage"
        ? idleCard(item)
        : { label: "reopened", tone: "coral", detail: "back in triage" }
    sync(before, item)
    return json(200, { state: to })
  }

  function retry(body: Record<string, unknown>, itemId: string): Response {
    const parsed = inputs.retry.safeParse({ ...body, itemId })
    if (!parsed.success) return invalid(parsed.error)
    if (parsed.data.note.trim() === "") return bad("note must not be empty")
    const item = find(parsed.data.itemId)
    if (!item) return notFound("Work item")
    if (item.attention !== "attempt_budget" || item.attempts.limit === null) {
      return appError(
        409,
        "CONFLICT",
        "This work item has attempts left, or is not waiting on one.",
      )
    }
    const before = structuredClone(item)
    item.attempts = { ...item.attempts, limit: item.attempts.limit + 1 }
    item.founderNotes = [
      ...item.founderNotes,
      { at: nowIso(), kind: "retry", text: parsed.data.note.trim() },
    ]
    event(item, "retry_granted", "A founder granted one more attempt.", {
      note: parsed.data.note.trim(),
      detail: { from: before.attempts.limit, to: item.attempts.limit },
    })
    clearAttention(item)
    sync(before, item, ["attempt_budget"])
    return json(200, { attemptLimit: item.attempts.limit })
  }

  function revert(body: Record<string, unknown>, itemId: string): Response {
    const parsed = inputs.note.safeParse({ ...body, itemId })
    if (!parsed.success) return invalid(parsed.error)
    const item = find(parsed.data.itemId)
    if (!item) return notFound("Work item")
    const pr = item.pullRequest
    if (!pr || pr.state !== "merged") {
      return appError(409, "CONFLICT", "A revert needs a merged pull request.")
    }
    if (!["deploy", "verify", "done"].includes(item.state))
      return cannotMove(item.state, "reopened")
    const before = structuredClone(item)
    moved(item, "reopened", "revert_requested", null)
    endWindow(item, "stopped")
    if (parsed.data.note) {
      item.founderNotes = [
        ...item.founderNotes,
        { at: nowIso(), kind: "revert", text: parsed.data.note },
      ]
    }
    event(item, "revert_requested", "A founder requested a revert.", {
      note: parsed.data.note ?? null,
      detail: { pullRequestUrl: pr.url, pullRequestNumber: pr.number, headSha: pr.headSha },
    })
    item.stages = stagesAt("triage")
    item.card = { label: "reopened", tone: "coral", detail: "back in triage" }
    sync(before, item)
    return json(200, { state: "reopened" })
  }

  /** Match a method and path to a route; `null` is a path hq has no route for. */
  function match(method: string, path: string): WorkRoute | null {
    const id = "([^/]+)"
    const dec = (value: string | undefined) => decodeURIComponent(value ?? "")
    let m: RegExpExecArray | null
    if (method === "GET") {
      if (path === "/v1/work/board") {
        return {
          write: false,
          run: () => {
            strict(true)
            return json(200, state.workBoard)
          },
        }
      }
      if (path === "/v1/work-items") {
        return {
          write: false,
          run: (search) => {
            strict(true)
            return listItems(search)
          },
        }
      }
      if ((m = new RegExp(`^/v1/work-items/${id}$`).exec(path))) {
        return {
          write: false,
          run: () => {
            strict(true)
            const parsed = inputs.get.safeParse({ itemId: dec(m?.[1]) })
            if (!parsed.success) return invalid(parsed.error)
            const item = find(parsed.data.itemId)
            return item ? json(200, item) : notFound("Work item")
          },
        }
      }
      return null
    }
    if (method !== "POST") return null
    if (path === "/v1/work-items") {
      return { write: true, run: (_s, body) => (strict(true), create(body)) }
    }
    if ((m = new RegExp(`^/v1/questions/${id}/answer$`).exec(path))) {
      const questionId = dec(m[1])
      return { write: true, run: (_s, body) => (strict(true), answer(body, questionId)) }
    }
    if ((m = new RegExp(`^/v1/work-items/${id}/([a-z-]+)$`).exec(path))) {
      const itemId = dec(m[1])
      const handlers: Record<string, (b: Record<string, unknown>, id: string) => Response> = {
        "attempt-requests": requestAttempt,
        "merge-approval": approve,
        stop,
        reopen,
        retry,
        "revert-request": revert,
      }
      const handler = handlers[m[2] ?? ""]
      if (handler) return { write: true, run: (_s, body) => (strict(true), handler(body, itemId)) }
    }
    return null
  }

  return { match, strict }
}

/** At most `max` UTF-16 units, cut between code points (hq's own cut). */
function firstChars(text: string, max: number): string {
  let out = ""
  for (const point of text) {
    if (out.length + point.length > max) break
    out += point
  }
  return out
}

function safeAtob(value: string): string {
  try {
    return atob(value)
  } catch {
    return "NaN"
  }
}
