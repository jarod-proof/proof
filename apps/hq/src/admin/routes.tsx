import { type AnyOperation, type Caller, invoke } from "@proof/api"
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { Hono } from "hono"

import { getEntryHistory } from "../data/entries"
import { DAILY_CAP } from "../data/money"
import { listProposals } from "../data/proposals"
import { readAllowance, spendSummary } from "../data/spend"
import { ADMIN_CSS } from "./layout"
import { LOGIN_SCRIPT } from "./login-script"
import { EntryPage, LoginPage, MessagePage, ProposalsPage, SpendPage } from "./pages"

export interface AdminOptions {
  db: Database
  now: () => Date
  /** The registry the pages act through: a decision is `decide_proposal`, never a direct write. */
  operations: readonly AnyOperation[]
  /** hq's front door: a caller that traces to a founder, or null when there is none. */
  authenticate: (req: Request) => Promise<Caller | null>
  /** A signed-in write must come from a trusted origin (the same check /v1 applies). */
  assertTrustedOrigin: (req: Request) => Promise<void>
}

/** The pages can't be framed (a click on Approve is the founder's), cached or sniffed. */
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  // Not no-referrer: that makes a browser send `Origin: null` on a form POST, and the Origin is what
  // the CSRF check reads.
  "referrer-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
}

/**
 * The minimal admin: proposals to decide, an entry's history, and spend. Founder session only:
 * a key or an OAuth token never reaches these pages, however it was minted.
 */
export function createAdminApp(opts: AdminOptions) {
  const { db, now, operations } = opts
  const admin = new Hono<{ Variables: { requestId: string } }>()

  admin.use(async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value)
  })

  admin.get("/admin.css", (c) =>
    c.body(ADMIN_CSS, 200, { "content-type": "text/css; charset=utf-8" }),
  )
  admin.get("/login.js", (c) =>
    c.body(LOGIN_SCRIPT, 200, { "content-type": "text/javascript; charset=utf-8" }),
  )

  admin.get("/login", (c) => c.html(<LoginPage next={c.req.query("next") ?? ""} />))

  /** The founder's session, or the response that turns the request away. */
  async function founderSession(
    req: Request,
  ): Promise<{ caller: Caller } | { response: Response }> {
    let caller: Caller | null
    try {
      caller = await opts.authenticate(req)
    } catch (error) {
      if (error instanceof AppError && error.status === 403) return { response: forbidden() }
      throw error
    }
    if (!caller) {
      const url = new URL(req.url)
      const next = encodeURIComponent(url.pathname + url.search)
      return { response: Response.redirect(new URL(`/admin/login?next=${next}`, url), 303) }
    }
    // The pages are for a person at a keyboard: a key or an OAuth token is turned away.
    if (caller.via !== "session") return { response: forbidden() }
    return { caller }
  }

  const forbidden = () =>
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not allowed · HQ</title></head>` +
        `<body><main><h1>Not allowed</h1><p>The admin pages are for the organization's founders, ` +
        `signed in.</p></main></body></html>`,
      { status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
    )

  admin.get("/", (c) => c.redirect("/admin/proposals", 303))

  admin.get("/proposals", async (c) => {
    const auth = await founderSession(c.req.raw)
    if ("response" in auth) return auth.response
    return c.html(await proposalsPage())
  })

  async function proposalsPage(error?: string) {
    const pending = await listProposals(db, { status: "pending", limit: 100 })
    const recent = await listProposals(db, { limit: 40 })
    return (
      <ProposalsPage
        pending={pending}
        decided={recent.filter((p) => p.status !== "pending").slice(0, 20)}
        error={error}
      />
    )
  }

  admin.post("/proposals/:id/decision", async (c) => {
    const auth = await founderSession(c.req.raw)
    if ("response" in auth) return auth.response
    await opts.assertTrustedOrigin(c.req.raw)
    const form = await c.req.parseBody()
    const field = (name: string) => (typeof form[name] === "string" ? form[name] : undefined)
    const note = field("note")?.trim()
    const op = operations.find((o) => o.name === "decide_proposal")
    if (!op) throw new AppError("INTERNAL", "decide_proposal is not registered")
    try {
      // The decision is decide_proposal's, with its founder check, CONFLICT rules and history.
      await invoke(
        op,
        { proposalId: c.req.param("id"), decision: field("decision"), ...(note ? { note } : {}) },
        { caller: auth.caller, requestId: c.get("requestId") },
      )
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        return c.html(await proposalsPage(error.message), error.status as 400)
      }
      throw error
    }
    return c.redirect("/admin/proposals", 303)
  })

  admin.get("/entries/:id", async (c) => {
    const auth = await founderSession(c.req.raw)
    if ("response" in auth) return auth.response
    try {
      return c.html(<EntryPage versions={await getEntryHistory(db, c.req.param("id"))} />)
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") {
        return c.html(<MessagePage title="Not found" message="There is no such entry." />, 404)
      }
      throw error
    }
  })

  admin.get("/spend", async (c) => {
    const auth = await founderSession(c.req.raw)
    if ("response" in auth) return auth.response
    const at = now()
    return c.html(
      <SpendPage
        allowance={await readAllowance(db, at)}
        rows={await spendSummary(db, { days: 30, now: at })}
        capUsd={DAILY_CAP}
      />,
    )
  })

  return admin
}
