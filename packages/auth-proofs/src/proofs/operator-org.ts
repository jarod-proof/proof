import { defineProof, type Named, type Proof } from "@gdp-ts/core"
import type { Caller } from "@proof/api"
import type { OrganizationId } from "../lib/ids"

const OperatorOrg = defineProof("OperatorOrg")
/**
 * Organization `O` is the operator organization (the one that runs the product and manages its
 * feature flags), and the caller acts for it.
 */
export interface OperatorOrg<O> extends Proof<"OperatorOrg", [O]> {}

/**
 * `operatorOrganizationId` is configuration (OPERATOR_ORGANIZATION_ID), passed in by the app.
 * Unset, no organization is the operator, so nothing is proved.
 */
export function operatorOrg<O>(
  caller: Caller,
  org: Named<O, OrganizationId>,
  operatorOrganizationId: string | undefined,
): OperatorOrg<O> | null {
  if (!operatorOrganizationId || org.value !== operatorOrganizationId) return null
  return caller.organizationId === org.value ? OperatorOrg.prove(org) : null
}
