import { defineProof, type Named, type Proof } from "@gdp-ts/core"
import type { Caller } from "@proof/api"
import type { OrganizationId } from "../lib/ids"

const CallerActsFor = defineProof("CallerActsFor")
/** The authenticated caller acts for organization `O`: its credential resolved to exactly `O`. */
export interface CallerActsFor<O> extends Proof<"CallerActsFor", [O]> {}

/**
 * Callers come from `resolvePrincipal`, which checks membership (sessions, OAuth) or key ownership.
 * This proof ties that result to the organization a query is about, so tenant data can't be read
 * with another organization's id.
 */
export function callerActsFor<O>(
  caller: Caller,
  org: Named<O, OrganizationId>,
): CallerActsFor<O> | null {
  return caller.organizationId === org.value ? CallerActsFor.prove(org) : null
}
