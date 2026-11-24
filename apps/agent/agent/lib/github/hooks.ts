import {
  defaultGitHubAuth,
  type GitHubCheckSuiteEvent,
  type GitHubComment,
  type GitHubInboundContext,
  type GitHubInboundResult,
  type GitHubIssueEvent,
  type GitHubPullRequestEvent,
} from "eve/channels/github"
import {
  BOX_REVIEW_LABEL,
  DEPS_BRANCH_PREFIX,
  FACTORY_BRANCH_PREFIX,
  FACTORY_LABEL,
} from "../constants.js"
import { stampAutonomous, stampIssueIntake, stampSummary, stampTrusted } from "../trust.js"
import { hookHq, recordSafely } from "../work/recorder.js"
import {
  ciSignal,
  issueSignal,
  pullRequestRecord,
  readIssueFacts,
  readPrFacts,
  readSuiteFacts,
  suiteChecks,
} from "../work/signals.js"
import { mentionPattern, resolveBotName } from "./bot-name.js"

/**
 * The GitHub channel's dispatch hooks: who may start a factory run from
 * GitHub, as whom, and with what task.
 *
 * @remarks
 * These live apart from the channel file so they can be exercised directly:
 * they are where trust is decided, on the signed webhook, before any model
 * runs. `agent/channels/github.ts` wires them into `githubChannel` and
 * documents the channel as a whole.
 */

/**
 * Commenter roles allowed to start a session by mentioning the agent.
 *
 * @remarks
 * GitHub's `author_association` on the comment payload. Anything outside this
 * set (CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, MANNEQUIN) is a user the
 * repo hasn't trusted with write access, so their mentions are acknowledged
 * without dispatching.
 */
const TRUSTED_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"])

/**
 * Replicates the channel's built-in ignore rules: eve's own marker comments,
 * bot authors, and the agent's own `<bot>[bot]` login.
 */
const isIgnoredComment = (comment: GitHubComment, botName: string): boolean => {
  if (comment.body.includes("<!-- eve:github:")) {
    return true
  }
  const { author } = comment
  if (author === undefined) {
    return false
  }
  return author.type === "Bot" || author.login.toLowerCase() === `${botName.toLowerCase()}[bot]`
}

const isTrustedCommenter = (comment: GitHubComment): boolean => {
  const association = comment.raw.author_association
  return typeof association === "string" && TRUSTED_ASSOCIATIONS.has(association)
}

/**
 * Repository roles allowed to hand an issue to the factory by labeling it.
 *
 * @remarks
 * GitHub's fine-grained role names from the collaborator-permission endpoint.
 * Triage is the floor: it is the permission normally required to apply a
 * label by hand.
 */
const TRUSTED_LABELER_ROLES = new Set(["admin", "maintain", "write", "triage"])

/**
 * Whether the webhook sender holds at least triage permission on the repo.
 *
 * @remarks
 * The issues webhook carries the issue author's association, never the
 * labeler's, and GitHub fires the `labeled` action even for labels attached
 * at creation time, which issue templates let unauthenticated reporters do.
 * Verifying the sender's permission against the API is what keeps the
 * unattended pipeline maintainer-triggered.
 *
 * @returns False on an API error too: it fails closed, and the event is
 * acknowledged without dispatching.
 */
const isTrustedLabeler = async (ctx: GitHubInboundContext): Promise<boolean> => {
  try {
    const response = await ctx.github.request<{
      permission?: string
      role_name?: string
    }>({
      method: "GET",
      path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/collaborators/${encodeURIComponent(ctx.sender.login)}/permission`,
    })
    if (!response.ok) {
      return false
    }
    const role = response.body.role_name ?? response.body.permission
    return typeof role === "string" && TRUSTED_LABELER_ROLES.has(role)
  } catch {
    return false
  }
}

/**
 * Task injected into an unattended intake session (an issue labeled with the
 * factory label). The session starts with the issue's number and title
 * only; the orchestrator reads the rest itself.
 */
export const FACTORY_INTAKE_TASK = [
  `This issue was handed to the factory with the "${FACTORY_LABEL}" label, and this run is unattended: nobody is watching to answer a question or approve an action, so never attempt an action that needs approval.`,
  "Triage the work item and run it through the pipeline. If it needs clarification, post the questions as a comment on the issue and stop; someone will re-label the issue when they've answered.",
  "Keep the requester in the loop as you go: post a short comment on this issue when triage and each station complete, except the last one. Comments on this issue are the one conversational write this run has; you cannot comment anywhere else.",
  "Deliver the finished work as a pull request ready for review. The message you end the run with appears on this issue for you: link the pull request there, and let it stand in for the progress comment for this final step.",
].join("\n\n")

/**
 * How many automated CI-fix attempts a factory pull request gets before the
 * factory pauses and hands the problem to a person.
 */
export const MAX_CI_FIX_ATTEMPTS = 2

/**
 * Task injected when a check suite fails on one of the factory's own pull
 * requests. The session is anchored to that pull request's thread.
 *
 * @remarks
 * The attempt cap is counted from the fix-attempt comments earlier runs
 * posted on the pull request, because each dispatch is a fresh session with
 * no memory of the last one: the thread is the only durable record they
 * share. That's also why the task posts the attempt comment before fixing,
 * not after; a run that dies mid-fix still leaves its mark for the next one
 * to count.
 */
export const CI_FIX_TASK = [
  "A CI check suite failed on one of the factory's own pull requests. This run is unattended: nobody is watching to answer a question or approve an action, so never attempt an action that needs approval.",
  "Before anything else, read the pull request fresh. If the failure belongs to a commit that is no longer the branch head, stop without posting anything.",
  `Count your own earlier fix-attempt comments on this pull request. If there are already ${MAX_CI_FIX_ATTEMPTS}, do not attempt another fix. Post one comment saying the factory is pausing its automated CI fixes on this pull request to avoid looping, ${MAX_CI_FIX_ATTEMPTS} attempts have not turned the checks green, and further troubleshooting needs a person. Then stop.`,
  "Otherwise, call diagnose_ci_failure with the pull request number. If nothing is failing by now (its status is passing, pending, cancelled, or no-checks), stop without posting anything. If fix_with_code is false, post one comment naming the failing check, the cause it found (a flaky test, a runner or service failure, or a workflow configuration problem), and that changing the code won't fix it, so a person should rerun or repair the workflow. Then stop; that comment does not count as a fix attempt.",
  "If the status is failing-no-log, the failing checks' logs could not be read and the cause is unknown: never say the code is fine. Post one comment naming the failing checks with their links and saying their logs weren't readable from here, so a person should look. Then stop; that comment does not count as a fix attempt either.",
  "If fix_with_code is true, first post a short comment that a CI fix attempt is starting and what looks broken (future runs count these comments to know when to stop). Then run the fix as a revision: send the implementer the pull request's context, its branch name, the failing checks, and the log excerpt, and have the reviewer judge the updated branch. Pushing the fix re-runs the checks; do not open a new pull request.",
].join("\n\n")

/**
 * Task injected into the session dispatched when a pull request opens. The
 * PR's metadata and changed-file patches are already in the session's context
 * when this runs; the repo itself is checked out into the sandbox.
 */
export const PR_SUMMARY_TASK = [
  "A pull request was just opened. Write one comment that helps reviewers get oriented, and make it your reply: it is posted on the pull request for you. This run can read the pull request and comment on it, and nothing else, so don't triage it, label it, or start any station.",
  "Open with a short paragraph saying what the PR does and why, grounded in its title, description, and diff. Never guess at intent the diff doesn't show.",
  "Then add a markdown table breaking down the changed files: the file path, the kind of change (added, modified, removed, renamed), and what changed in one short phrase. For a very large PR, list the files that carry the substance and roll the rest into a final count row.",
  "Close with one line pointing reviewers at where to start. This comment is a summary, not a review: don't approve, request changes, or ask the author for anything.",
].join("\n\n")

/**
 * Red CI on one of the factory's own pull requests: dispatches an unattended
 * fix run, anchored to that pull request. Suites on branches people pushed
 * never dispatch.
 *
 * @remarks
 * After the dispatch is decided (unchanged), the suite is also recorded in hq: a failure on the
 * default branch with no pull request is a `ci_failure` signal, and a completed suite on a factory
 * branch's pull request updates that pull request's checks. Recording never changes the result and
 * never throws.
 *
 * @returns The run to start, or null to acknowledge the event without one.
 */
export const onCheckSuite = async (
  ctx: GitHubInboundContext,
  suite: GitHubCheckSuiteEvent,
): Promise<GitHubInboundResult> => {
  const result = checkSuiteDispatch(ctx, suite)
  await recordSafely("check_suite", async () => {
    const hq = hookHq()
    if (hq === null) {
      return null
    }
    const facts = readSuiteFacts(ctx, suite)
    const signal = ciSignal(facts)
    if (signal !== null) {
      return hq.recordSignal(signal)
    }
    const checks = suiteChecks(facts)
    return checks === null ? null : hq.recordPullRequest(checks)
  })
  return result
}

const checkSuiteDispatch = (
  ctx: GitHubInboundContext,
  suite: GitHubCheckSuiteEvent,
): GitHubInboundResult => {
  const raw = suite.raw as {
    head_branch?: unknown
    check_suite?: { head_branch?: unknown }
  }
  const headBranch = raw.head_branch ?? raw.check_suite?.head_branch
  const [pullNumber] = suite.pullRequests
  if (
    suite.action !== "completed" ||
    suite.conclusion !== "failure" ||
    pullNumber === undefined ||
    typeof headBranch !== "string" ||
    !headBranch.startsWith(FACTORY_BRANCH_PREFIX)
  ) {
    return null
  }
  return {
    auth: stampAutonomous(defaultGitHubAuth(ctx), pullNumber),
    context: [CI_FIX_TASK],
  }
}

/**
 * A mention of the factory: dispatches an attended, trusted run, but only
 * for commenters the repository trusts (owner, member, collaborator).
 *
 * @returns The run to start, or null to acknowledge the event without one.
 */
export const onComment = async (
  ctx: GitHubInboundContext,
  comment: GitHubComment,
): Promise<GitHubInboundResult> => {
  // A resolution failure means the mention can't be matched; acknowledge
  // without dispatching and let the next event retry.
  const botName = await resolveBotName().catch(() => null)
  if (botName === null) {
    return null
  }
  return !isIgnoredComment(comment, botName) &&
    mentionPattern(botName).test(comment.body) &&
    isTrustedCommenter(comment)
    ? { auth: stampTrusted(defaultGitHubAuth(ctx)) }
    : null
}

/**
 * The factory label on an issue: dispatches the unattended pipeline, after
 * verifying that whoever applied the label may triage the repository.
 *
 * @remarks
 * The issue is also recorded in hq as a signal when a trusted party is behind it: an issue opened
 * or reopened by an owner, member or collaborator, or labeled by a verified labeler (the answer
 * the dispatch already needed, asked once). A stranger's issue on the public repo records nothing.
 * Recording never changes the result and never throws.
 *
 * @returns The run to start, or null to acknowledge the event without one.
 */
export const onIssue = async (
  ctx: GitHubInboundContext,
  issue: GitHubIssueEvent,
): Promise<GitHubInboundResult> => {
  const { labels } = issue.raw as {
    labels?: ReadonlyArray<{ name?: unknown }>
  }
  const hasFactoryLabel =
    Array.isArray(labels) && labels.some((entry) => entry?.name === FACTORY_LABEL)
  const labeledByTrusted =
    issue.action === "labeled" &&
    hasFactoryLabel &&
    ctx.sender.type !== "Bot" &&
    (await isTrustedLabeler(ctx))
  const result: GitHubInboundResult = labeledByTrusted
    ? {
        auth: stampIssueIntake(defaultGitHubAuth(ctx), issue.issueNumber),
        context: [FACTORY_INTAKE_TASK],
      }
    : null
  await recordSafely("issue", async () => {
    const hq = hookHq()
    if (hq === null) {
      return null
    }
    const signal = issueSignal(readIssueFacts(ctx, issue, labeledByTrusted))
    return signal === null ? null : hq.recordSignal(signal)
  })
  return result
}

/**
 * A pull request opened by a person: dispatches a summary-only run. Bot-opened
 * pull requests, the factory's own included, are skipped.
 *
 * @remarks
 * Deliberately not gated on who opened it: orienting reviewers on an outside
 * contributor's pull request is the point. That makes the pull request's
 * text the least trustworthy input the factory reads, so the run it starts
 * is the narrowest one there is (`stampSummary`): it can read and comment
 * on that pull request, and nothing else, whatever the text says.
 *
 * Every event for one of the factory's own pull requests (any action, bot senders included) is
 * also recorded in hq, in full, once the dispatch is decided; a fork's `agent/...` branch is not
 * one of them. Recording never changes the result and never throws.
 *
 * @returns The run to start, or null to acknowledge the event without one.
 */
export const onPullRequest = async (
  ctx: GitHubInboundContext,
  pullRequest: GitHubPullRequestEvent,
): Promise<GitHubInboundResult> => {
  const result: GitHubInboundResult =
    pullRequest.action === "opened" &&
    ctx.sender.type !== "Bot" &&
    !belongsToAnotherSystem(pullRequest)
      ? {
          auth: stampSummary(defaultGitHubAuth(ctx), pullRequest.pullRequestNumber),
          context: [PR_SUMMARY_TASK],
        }
      : null
  await recordSafely("pull_request", async () => {
    const hq = hookHq()
    if (hq === null) {
      return null
    }
    const facts = readPrFacts(ctx, pullRequest)
    const record = facts === null ? null : pullRequestRecord(facts)
    return record === null ? null : hq.recordPullRequest(record)
  })
  return result
}

/**
 * A pull request that another system owns: box review's (labeled `factory:review`) or a dependency
 * update's (branch `deps/...`). No label or branch may trigger another system, so neither starts
 * a summary run. The payload is read as GitHub sends it, with the pull request under
 * `pull_request` or as the object itself.
 */
function belongsToAnotherSystem(pullRequest: GitHubPullRequestEvent): boolean {
  const raw = pullRequest.raw as {
    pull_request?: { head?: { ref?: unknown }; labels?: unknown }
    head?: { ref?: unknown }
    labels?: unknown
  }
  const pr = raw.pull_request ?? raw
  const ref = pr.head?.ref
  const labels = pr.labels
  return (
    (typeof ref === "string" && ref.startsWith(DEPS_BRANCH_PREFIX)) ||
    (Array.isArray(labels) &&
      labels.some((entry) => (entry as { name?: unknown } | null)?.name === BOX_REVIEW_LABEL))
  )
}
