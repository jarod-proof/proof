import type {
  GitHubCheckSuiteEvent,
  GitHubInboundContext,
  GitHubIssueEvent,
  GitHubPullRequestEvent,
} from "eve/channels/github"
import type { PullRequestCheck, RecordPullRequestInput, RecordSignalInput } from "../hq/client.js"
import { FACTORY_BRANCH_PREFIX, FACTORY_LABEL, FACTORY_REPO } from "../constants.js"
import { recordDropped } from "./recorder.js"
import { storable } from "./storable.js"

/**
 * What a GitHub webhook becomes in hq: pure mappers from the event's facts to the input of
 * `record_signal` and `record_pull_request`, and the readers that lift those facts out of the
 * payload. Nothing here calls hq or GitHub.
 *
 * @remarks
 * Every mapper returns null when it records nothing, and the reasons are the trust model:
 *
 * - The repositories are public, so a stranger can open an issue. Only an issue opened by an
 *   OWNER, MEMBER or COLLABORATOR, or labeled with the factory label by a labeler the hook
 *   verified, is a signal. Everything else records nothing.
 * - Any pull request event for the factory's own branch is recorded, in full, but only when the
 *   branch lives in this repository: a fork can name its branch `agent/...` too.
 * - Every repo is lower-cased (GitHub owners are mixed-case and hq compares lower-cased), and
 *   every mapper first requires the factory repo, so a mirror the App is also installed on is
 *   never a source.
 * - All text is untrusted: it is cut, scrubbed of what hq cannot store, and sent as data. A url
 *   is built from the repo and a number, never taken from the payload.
 */

/** A check suite has no default branch in its event; the factory's repository uses `main`. */
export const CI_DEFAULT_BRANCH = "main"

const TITLE_MAX = 300
const BODY_MAX = 4000
const LABELS_MAX = 20
/** hq refuses a payload over 20 000 serialized bytes; control characters grow six-fold in JSON. */
const PAYLOAD_BUDGET_BYTES = 18_000
/** Issue authors the repository trusts (GitHub's `author_association`). Nothing else is a signal. */
const TRUSTED_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
/** hq's dedupe pattern for a ci_failure: the app slug segment. */
const APP_SLUG = /^[\w.-]+$/
const BRANCH_NAME = /^[^:\s]+$/
const COMMIT_ID = /^[0-9a-f]{7,64}$/i

/** Whether a repository is the factory's own, compared lower-cased. */
export const isFactoryRepo = (repo: string): boolean =>
  repo.toLowerCase() === FACTORY_REPO.toLowerCase()

// ---------------------------------------------------------------------------------------------
// Reading untrusted payloads without throwing.
// ---------------------------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const text = (value: unknown): string | null => (typeof value === "string" ? value : null)
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647
    ? value
    : null

const issueUrl = (repo: string, number: number) => `https://github.com/${repo}/issues/${number}`
const pullUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`

// ---------------------------------------------------------------------------------------------
// Issues.
// ---------------------------------------------------------------------------------------------

export interface IssueFacts {
  repo: string
  number: number
  title: string
  body: string
  action: string
  authorAssociation: string | null
  authorLogin: string
  authorType: string
  updatedAt: string
  labelNames: string[]
  /** The hook's own verified answer for the `labeled` action: the labeler holds triage or more. */
  labeledByTrusted: boolean
}

/** Lifts an issue event's facts: the repo from the context, the rest from `issue.raw`. */
export function readIssueFacts(
  ctx: GitHubInboundContext,
  issue: GitHubIssueEvent,
  labeledByTrusted: boolean,
): IssueFacts {
  const raw = record(issue.raw) ?? {}
  const user = record(raw.user)
  const labels = Array.isArray(raw.labels) ? raw.labels : []
  return {
    repo: ctx.repository.fullName.toLowerCase(),
    number: issue.issueNumber,
    title: text(raw.title) ?? "",
    body: text(raw.body) ?? "",
    action: issue.action,
    authorAssociation: text(raw.author_association),
    authorLogin: text(user?.login) ?? "",
    authorType: text(user?.type) ?? "",
    updatedAt: text(raw.updated_at) ?? "",
    labelNames: labels.flatMap((entry) => {
      const name = text(record(entry)?.name)
      return name === null ? [] : [name]
    }),
    labeledByTrusted,
  }
}

/** The body, halved until the whole payload fits the budget hq enforces. */
function fitPayload(payload: { body: string } & Record<string, unknown>): Record<string, unknown> {
  while (
    payload.body.length > 0 &&
    Buffer.byteLength(JSON.stringify(payload)) > PAYLOAD_BUDGET_BYTES
  ) {
    payload.body = storable(payload.body, Math.floor(payload.body.length / 2))
  }
  return payload
}

/**
 * The `github_issue` signal of an issue event, or null.
 *
 * @remarks
 * Recorded when the issue was opened or reopened by a trusted, non-bot author, or when it was
 * labeled with the factory label by a labeler the hook verified. The dedupe key names the issue,
 * the external id names the delivery's action and time, so a redelivery is a duplicate and the
 * same issue opened then labeled is one item with two signals.
 */
export function issueSignal(f: IssueFacts): RecordSignalInput | null {
  const repo = f.repo.toLowerCase()
  if (!isFactoryRepo(repo)) {
    return null
  }
  const authored =
    (f.action === "opened" || f.action === "reopened") &&
    f.authorAssociation !== null &&
    TRUSTED_AUTHORS.has(f.authorAssociation) &&
    f.authorType !== "Bot" &&
    !f.authorLogin.endsWith("[bot]")
  const labeled =
    f.action === "labeled" && f.labelNames.includes(FACTORY_LABEL) && f.labeledByTrusted
  if (!authored && !labeled) {
    return null
  }
  const login = storable(f.authorLogin, 100) || "unknown"
  const title = storable(f.title, TITLE_MAX)
  return {
    source: "github_issue",
    externalId: `${repo}#${f.number}:${f.action}:${storable(f.updatedAt, 40) || "unknown"}`,
    dedupeKey: `github-issue:${repo}#${f.number}`,
    repo,
    title: title.trim() === "" ? `Issue #${f.number}` : title,
    summary: `GitHub issue #${f.number} ${f.action} by ${login}`,
    url: issueUrl(repo, f.number),
    payload: fitPayload({
      number: f.number,
      action: f.action,
      author: login,
      labels: f.labelNames.slice(0, LABELS_MAX).map((name) => storable(name, 100)),
      body: storable(f.body, BODY_MAX),
    }),
  }
}

// ---------------------------------------------------------------------------------------------
// Check suites.
// ---------------------------------------------------------------------------------------------

export interface SuiteFacts {
  repo: string
  action: string
  conclusion: string | null
  status: string | null
  appSlug: string | null
  headBranch: string | null
  headSha: string | null
  suiteId: number
  pullRequests: number[]
  defaultBranch: string
  /** The suite's pull request comes from another repository (its head repo is not the base's). */
  fromFork: boolean
}

/**
 * Lifts a check-suite event's facts. The event is one suite (its `app.slug` and `conclusion` are
 * the suite's own); a commit has several suites and none is picked by an index. The context has no
 * raw payload, so the default branch is the constant {@link CI_DEFAULT_BRANCH}.
 */
export function readSuiteFacts(
  ctx: GitHubInboundContext,
  suite: GitHubCheckSuiteEvent,
): SuiteFacts {
  const raw = record(suite.raw) ?? {}
  const pullRequests = Array.isArray(suite.pullRequests)
    ? suite.pullRequests.filter((n): n is number => typeof n === "number")
    : []
  const first = pullRequests[0]
  const entries = Array.isArray(raw.pull_requests) ? raw.pull_requests : []
  const entry = entries.map(record).find((e) => e !== null && e.number === first)
  const headRepoId = record(record(entry?.head)?.repo)?.id
  const baseRepoId = record(record(entry?.base)?.repo)?.id
  return {
    repo: ctx.repository.fullName.toLowerCase(),
    action: suite.action,
    conclusion: text(suite.conclusion),
    status: text(suite.status),
    appSlug: text(record(suite.app)?.slug),
    headBranch: text(raw.head_branch) ?? text(record(raw.check_suite)?.head_branch),
    headSha: text(suite.headSha) ?? text(raw.head_sha),
    suiteId: suite.checkSuiteId,
    pullRequests,
    defaultBranch: CI_DEFAULT_BRANCH,
    fromFork:
      typeof headRepoId === "number" && typeof baseRepoId === "number" && headRepoId !== baseRepoId,
  }
}

/**
 * The `ci_failure` signal of a failed suite on the default branch that no pull request carries, or
 * null. The key is the repo, branch and the suite's app, so two apps failing are two problems.
 */
export function ciSignal(f: SuiteFacts): RecordSignalInput | null {
  const repo = f.repo.toLowerCase()
  const { appSlug, headBranch } = f
  if (
    !isFactoryRepo(repo) ||
    f.action !== "completed" ||
    f.conclusion !== "failure" ||
    f.pullRequests.length > 0 ||
    appSlug === null ||
    !APP_SLUG.test(appSlug) ||
    headBranch === null ||
    headBranch !== f.defaultBranch ||
    !BRANCH_NAME.test(headBranch) ||
    !Number.isInteger(f.suiteId)
  ) {
    return null
  }
  const sha = f.headSha !== null && COMMIT_ID.test(f.headSha) ? f.headSha : null
  return {
    source: "ci_failure",
    externalId: `${repo}:check_suite:${f.suiteId}`,
    dedupeKey: `ci:${repo}:${headBranch}:${appSlug}`,
    repo,
    title: storable(`CI failed on ${headBranch}: ${appSlug}`, TITLE_MAX),
    summary: `${appSlug} check suite failed on ${headBranch}${sha === null ? "" : ` at ${sha.slice(0, 7)}`}`,
    ...(sha === null ? {} : { url: `https://github.com/${repo}/commit/${sha}` }),
  }
}

/**
 * The checks-only `record_pull_request` of a completed suite on a factory branch's pull request,
 * or null. It sends no head sha and no state: a late suite for an older commit must not move what
 * hq knows of the head, and hq accepts it once the row exists.
 */
export function suiteChecks(f: SuiteFacts): RecordPullRequestInput | null {
  const repo = f.repo.toLowerCase()
  const number = f.pullRequests[0]
  if (
    !isFactoryRepo(repo) ||
    f.action !== "completed" ||
    number === undefined ||
    f.fromFork ||
    f.appSlug === null ||
    f.headBranch === null ||
    !f.headBranch.startsWith(FACTORY_BRANCH_PREFIX)
  ) {
    return null
  }
  const state: PullRequestCheck["state"] =
    f.conclusion === "success" ? "passed" : f.conclusion === "failure" ? "failed" : "pending"
  return {
    branch: f.headBranch,
    number,
    url: pullUrl(repo, number),
    checks: [{ name: f.appSlug, state }],
  }
}

// ---------------------------------------------------------------------------------------------
// Pull requests.
// ---------------------------------------------------------------------------------------------

export interface PrFacts {
  /** The base repository (the webhook's repository), lower-cased. */
  repo: string
  number: number
  action: string
  headRef: string
  headSha: string
  base: string
  draft: boolean
  /** The head repository, lower-cased; null when it is gone (a deleted fork). */
  headRepo: string | null
  merged: boolean
  mergedAt: string | null
  mergedBy: string | null
  /** What the pull request object says: `closed` for a merged or a closed one. */
  prState: "open" | "closed"
  additions: number | null
  deletions: number | null
  changedFiles: number | null
}

/**
 * Lifts a pull-request event's facts. The event's `raw` holds the pull request under
 * `pull_request` or as the object itself. Without a head ref, a head sha, a base or the draft
 * flag the first record cannot be made: null, and the drop is logged as `unmappable`.
 */
export function readPrFacts(
  ctx: GitHubInboundContext,
  pullRequest: GitHubPullRequestEvent,
): PrFacts | null {
  const raw = record(pullRequest.raw) ?? {}
  const pr = record(raw.pull_request) ?? raw
  const head = record(pr.head)
  const baseRef = text(record(pr.base)?.ref)
  const headRef = text(head?.ref)
  const headSha = text(head?.sha) ?? text(pullRequest.headSha)
  const draft = typeof pr.draft === "boolean" ? pr.draft : null
  if (
    headRef === null ||
    headRef === "" ||
    headSha === null ||
    !COMMIT_ID.test(headSha) ||
    baseRef === null ||
    baseRef === "" ||
    draft === null
  ) {
    recordDropped("pull_request", "unmappable")
    return null
  }
  return {
    repo: ctx.repository.fullName.toLowerCase(),
    number: pullRequest.pullRequestNumber,
    action: pullRequest.action,
    headRef,
    headSha,
    base: baseRef,
    draft,
    headRepo: text(record(head?.repo)?.full_name)?.toLowerCase() ?? null,
    merged: pr.merged === true,
    mergedAt: text(pr.merged_at),
    mergedBy: text(record(pr.merged_by)?.login),
    prState: pr.state === "closed" ? "closed" : "open",
    additions: count(pr.additions),
    deletions: count(pr.deletions),
    changedFiles: count(pr.changed_files),
  }
}

/**
 * The full `record_pull_request` of a factory pull request, or null.
 *
 * @remarks
 * Sent for every action and for bot senders (the factory's own pull requests are bot-opened), with
 * everything hq needs for a first record, so a lost record is healed by the next event. A branch
 * under the factory prefix is the factory's only when its head repository is this repository: a
 * fork's `agent/...` branch is a stranger's pull request. The url is built, never copied.
 *
 * The state is what the pull request says, not only what this action did: a label added later to
 * a closed pull request must not send `open`, which hq would take as a reopening. `mergedAt` and
 * `mergedBy` go only with a merge.
 */
export function pullRequestRecord(f: PrFacts): RecordPullRequestInput | null {
  const repo = f.repo.toLowerCase()
  if (
    !isFactoryRepo(repo) ||
    !f.headRef.startsWith(FACTORY_BRANCH_PREFIX) ||
    f.headRepo === null ||
    f.headRepo.toLowerCase() !== repo
  ) {
    return null
  }
  const state = f.merged
    ? "merged"
    : f.prState === "closed" || f.action === "closed"
      ? "closed"
      : "open"
  const mergedAt = f.mergedAt !== null && !Number.isNaN(Date.parse(f.mergedAt)) ? f.mergedAt : null
  return {
    branch: f.headRef,
    number: f.number,
    url: pullUrl(repo, f.number),
    base: f.base,
    headSha: f.headSha,
    isDraft: f.draft,
    state,
    ...(f.additions === null ? {} : { additions: f.additions }),
    ...(f.deletions === null ? {} : { deletions: f.deletions }),
    ...(f.changedFiles === null ? {} : { files: f.changedFiles }),
    ...(state === "merged" && f.mergedBy !== null ? { mergedBy: storable(f.mergedBy, 100) } : {}),
    ...(state === "merged" && mergedAt !== null ? { mergedAt } : {}),
  }
}
