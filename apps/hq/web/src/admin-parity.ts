/**
 * Every route the /admin pages register (src/admin/routes.tsx), and where the SPA does the same
 * job. `spa` is the /app path a founder uses instead, or null for a gap. A covered row with a null
 * `spa` is a static asset of the /admin pages, not a screen. The retirement of /admin waits for
 * every gap to close.
 */
export const ADMIN_PARITY: {
  adminPath: string
  spa: string | null
  status: "covered" | "gap"
  note: string
}[] = [
  {
    adminPath: "GET /admin/login",
    spa: "/app/sign-in",
    status: "covered",
    note: "Founder sign-in; the SPA signs in at /app/sign-in and returns to ?next.",
  },
  {
    adminPath: "GET /admin/",
    spa: "/app/approvals",
    status: "covered",
    note: "Redirects to the proposals page, which is Approvals.",
  },
  {
    adminPath: "GET /admin/proposals",
    spa: "/app/approvals",
    status: "covered",
    note: "Needs you (pending) and the recently decided proposals.",
  },
  {
    adminPath: "POST /admin/proposals/:id/decision",
    spa: "/app/approvals",
    status: "covered",
    note: "Approve or reject through decide_proposal, with the same founder check.",
  },
  {
    adminPath: "GET /admin/entries/:id",
    spa: null,
    status: "gap",
    note: "Entry version history. The Approvals History link still goes here; no SPA screen shows it.",
  },
  {
    adminPath: "GET /admin/spend",
    spa: null,
    status: "gap",
    note: "Spend for 30 days by day, source and task. Runner shows only today's allowance.",
  },
  {
    adminPath: "GET /admin/admin.css",
    spa: null,
    status: "covered",
    note: "Stylesheet of the /admin pages; the SPA ships its own styles.",
  },
  {
    adminPath: "GET /admin/login.js",
    spa: null,
    status: "covered",
    note: "Script of the /admin sign-in page; the SPA ships its own script.",
  },
]
