import type { EntryVersionRow } from "../data/entries"
import { formatUnits, type Units } from "../data/money"
import type { ProposalRow } from "../data/proposals"
import type { Allowance, SpendSummaryRow } from "../data/spend"
import { Layout } from "./layout"

const usd = (units: Units) => `$${formatUnits(units)}`
const when = (at: Date) => at.toISOString().replace("T", " ").slice(0, 16) + " UTC"

export function LoginPage(props: { next: string }) {
  return (
    <Layout title="Sign in" nav={false}>
      <h1>Sign in</h1>
      <p className="meta">Founders only.</p>
      <form id="login" data-next={props.next}>
        <p className="error" id="login-error" role="alert" hidden />
        <div className="actions">
          <label>
            Email
            <input name="email" type="email" autocomplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
          <button type="submit">Sign in</button>
        </div>
      </form>
      <script src="/admin/login.js" defer />
    </Layout>
  )
}

function ProposalCard(props: { proposal: ProposalRow; actions: boolean }) {
  const p = props.proposal
  return (
    <article className="card" aria-label={`Proposal: ${p.title}`}>
      <h2>{p.title}</h2>
      <p className="meta">
        {p.kind} / {p.slug}
        {p.baseVersion === null ? " (new entry)" : ` (changes version ${p.baseVersion})`} · proposed
        by {p.proposedBy.type} {p.proposedBy.id} · {when(p.createdAt)}
      </p>
      <p className="body">{p.body.text}</p>
      <p className="meta">Reason: {p.reason}</p>
      {p.status !== "pending" ? (
        <p className="meta">
          {p.status} {p.decidedAt ? when(p.decidedAt) : ""}
          {p.decisionNote ? ` · ${p.decisionNote}` : ""}
          {p.status === "approved" && p.entryId ? (
            <>
              {" · "}
              <a href={`/admin/entries/${encodeURIComponent(p.entryId)}`}>History</a>
            </>
          ) : null}
        </p>
      ) : null}
      {props.actions ? (
        <form
          method="post"
          action={`/admin/proposals/${encodeURIComponent(p.id)}/decision`}
          className="actions"
        >
          <label>
            Note (optional)
            <input name="note" type="text" maxlength={2000} />
          </label>
          <button type="submit" name="decision" value="approve" className="approve">
            Approve
          </button>
          <button type="submit" name="decision" value="reject" className="reject">
            Reject
          </button>
        </form>
      ) : null}
    </article>
  )
}

export function ProposalsPage(props: {
  pending: ProposalRow[]
  decided: ProposalRow[]
  error?: string
}) {
  return (
    <Layout title="Proposals">
      <h1>Proposals</h1>
      {props.error ? (
        <p className="error" role="alert">
          {props.error}
        </p>
      ) : null}
      <h2>Pending</h2>
      {props.pending.length === 0 ? <p className="meta">Nothing is waiting for you.</p> : null}
      {props.pending.map((p) => (
        <ProposalCard proposal={p} actions />
      ))}
      <h2>Recently decided</h2>
      {props.decided.length === 0 ? <p className="meta">Nothing decided yet.</p> : null}
      {props.decided.map((p) => (
        <ProposalCard proposal={p} actions={false} />
      ))}
    </Layout>
  )
}

export function EntryPage(props: { versions: EntryVersionRow[] }) {
  const newest = props.versions.at(-1)
  return (
    <Layout title={newest?.title ?? "Entry"}>
      <h1>{newest?.title ?? "Entry"}</h1>
      <p className="meta">
        {newest?.kind} / {newest?.slug} · {props.versions.length} version
        {props.versions.length === 1 ? "" : "s"}. Nothing is overwritten or deleted.
      </p>
      <h2>History</h2>
      {[...props.versions].reverse().map((v) => (
        <article className="card" aria-label={`Version ${v.version}`}>
          <h3>Version {v.version}</h3>
          <p className="meta">
            {v.author.type} {v.author.id} · {when(v.createdAt)}
            {v.source ? ` · from ${v.source}` : ""}
          </p>
          <p className="body">{v.body.text}</p>
        </article>
      ))}
    </Layout>
  )
}

export function SpendPage(props: { allowance: Allowance; rows: SpendSummaryRow[]; capUsd: Units }) {
  const a = props.allowance
  const total = (source: string) =>
    props.rows.filter((r) => r.source === source).reduce((sum, r) => sum + r.amount, 0)
  return (
    <Layout title="Spend">
      <h1>Spend</h1>
      <h2>Today ({a.day}, UTC)</h2>
      <table>
        <caption>Eve chat and schedules count toward the daily cap</caption>
        <tbody>
          <tr>
            <th scope="row">Cap</th>
            <td className="num">{usd(props.capUsd)}</td>
          </tr>
          <tr>
            <th scope="row">Granted today</th>
            <td className="num">{usd(a.granted)}</td>
          </tr>
          <tr>
            <th scope="row">Spent (settled, plus stale holds)</th>
            <td className="num">{usd(a.spent)}</td>
          </tr>
          <tr>
            <th scope="row">Reserved (turns in flight)</th>
            <td className="num">{usd(a.reserved)}</td>
          </tr>
          <tr>
            <th scope="row">Remaining</th>
            <td className="num">{usd(Math.max(0, a.remaining))}</td>
          </tr>
        </tbody>
      </table>
      <h2>Last 30 days</h2>
      <p className="meta">
        Eve {usd(total("eve"))} · build {usd(total("build"))} · box {usd(total("box"))}. Build and
        box spend is outside the cap. An estimated amount is a cost the provider did not report.
      </p>
      {props.rows.length === 0 ? (
        <p className="meta">No spend recorded in the last 30 days.</p>
      ) : (
        <table>
          <caption>By day, source and task</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Source</th>
              <th scope="col">Task</th>
              <th scope="col" className="num">
                Amount
              </th>
              <th scope="col" className="num">
                Of which estimated
              </th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr>
                <td>{r.day}</td>
                <td>{r.source}</td>
                <td>{r.task ?? "(no run)"}</td>
                <td className="num">{usd(r.amount)}</td>
                <td className="num">{usd(r.estimated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  )
}

export function MessagePage(props: { title: string; message: string }) {
  return (
    <Layout title={props.title}>
      <h1>{props.title}</h1>
      <p>{props.message}</p>
    </Layout>
  )
}
