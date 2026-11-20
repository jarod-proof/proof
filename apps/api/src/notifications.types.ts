// Type-level: an org event needs the organization as a proof and the caller's proof of acting in it, so
// an operation can only notify the org it acts in. A raw id, or a name with no proof, is refused.
// Checked by `pnpm typecheck` (apps/api/tsconfig.json includes *.types.ts).
import { name, OrganizationId } from "@proof/auth-proofs"
import type { ApiNotifier } from "./notifications"

declare const notifier: ApiNotifier

// @ts-expect-error a raw organization id is not a proof that the caller acts in it
void notifier.inOrg("org_1", undefined, { type: "billing.payment_failed" })

void name(OrganizationId("org_1"), (org) =>
  // @ts-expect-error a name with no CallerActsFor proof is refused
  notifier.inOrg(org, undefined, { type: "billing.payment_failed" }),
)
