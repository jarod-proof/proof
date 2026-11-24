// Type-level checks (pnpm typecheck runs them; nothing imports this file and nothing calls the
// function): `requestAttempt` has no default origin, so a call without one, or with a third one,
// is a compile error.
import type { Database } from "@proof/db"

import { requestAttempt } from "./attempts"

export async function originIsRequired(db: Database, now: Date) {
  const base = { itemId: "i", kind: "investigate", founderId: "f", now } as const
  await requestAttempt(db, { ...base, origin: "founder_request" })
  await requestAttempt(db, { ...base, origin: "policy_dispatch" })
  // @ts-expect-error origin is required: there is no default
  await requestAttempt(db, { ...base })
  // @ts-expect-error not one of the two origins
  await requestAttempt(db, { ...base, origin: "nobody" })
}
