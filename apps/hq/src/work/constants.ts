// The numbers of the work pipeline. Pure data: no I/O, no clock.

/** How long a merged change is watched after the deploy grace. */
export const VERIFY_WINDOW_HOURS = 6
/** The deploy is never observed: hq assumes it landed this long after the merge. */
export const DEPLOY_GRACE_MINUTES = 15
/** A signal for a `done` item within this many days reopens it; later it makes a new item. */
export const RECURRENCE_REOPEN_DAYS = 7
/** An attempt that has not reported for this long is stale (then abandoned by the sweep). */
export const ATTEMPT_LEASE_MINUTES = 45
export const PAYLOAD_MAX_BYTES = 20_000
export const NOTE_MAX_CHARS = 2000
export const BOARD_COLUMN_CAP = 30
export const MAX_QUESTION_OPTIONS = 5

/** `label`: an attempt starts from the trusted `agent:build` label. `claim`: from a founder's request. */
export const ATTEMPT_DISPATCH_MODE: "label" | "claim" = "label"

// The caps of what an attempt may carry (the data layer enforces them; the operations' schemas and
// the web import the same numbers, so a field's limit is stated once).
export const EXTERNAL_REF_MAX_CHARS = 200
export const RUN_ID_MAX_CHARS = 200
export const BRANCH_MAX_CHARS = 200
export const SESSION_ID_MAX_CHARS = 200
export const FILES_MAX = 200
export const FILE_MAX_CHARS = 500
export const ATTEMPT_LIMIT_MAX = 10
