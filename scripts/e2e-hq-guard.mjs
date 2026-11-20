// The e2e hq stack writes to its database: it clears the rate_limit table and marks the seeded
// founder's address verified. That is only for a throwaway database, a worktree's (`*_wt_*`, made by
// `pnpm wt`) or a test one (`*_test`): rate_limit holds the product's brute-force counters too, so
// a shared dev database must never be reset by an e2e run.
const DISPOSABLE = /(_wt_|_test$)/

/** The database name in a connection URL, or "" when it isn't a URL. */
export function databaseName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1))
  } catch {
    return ""
  }
}

/** Throws unless `url` names a disposable database. */
export function assertDisposableDatabase(url) {
  const name = databaseName(url)
  if (!DISPOSABLE.test(name)) {
    throw new Error(
      `refusing to seed or reset "${name || "(unreadable URL)"}": the e2e hq stack only writes to a ` +
        "database named *_wt_* (pnpm wt) or *_test. Point HQ_DATABASE_URL at one.",
    )
  }
}
