// The organization a caller acts in, as the proof tenant data functions require. Metering, audit and
// idempotency reach org data through this too.
import type { Caller } from "@proof/api"
import {
  type CallerActsFor,
  callerActsFor,
  type Named,
  name,
  type OperatorOrg,
  OrganizationId,
  operatorOrg,
} from "@proof/auth-proofs"
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"

/** Run `fn` in the caller's organization, with the proof that tenant data access requires. */
export function inCallerOrg<T>(
  caller: Caller,
  fn: <O>(org: Named<O, OrganizationId>, proof: CallerActsFor<O>) => Promise<T>,
): Promise<T> {
  return name(OrganizationId(caller.organizationId), (org) => {
    const proof = callerActsFor(caller, org)
    if (!proof) throw new AppError("FORBIDDEN", "Not acting for this organization")
    return fn(org, proof)
  })
}

/**
 * The operator organization (OPERATOR_ORGANIZATION_ID): the one that runs the product and manages
 * its feature flags. Read at call time, so tests can name theirs once it exists.
 */
export interface Operator {
  organizationId: string | undefined
}

/** Whether the caller acts for the operator organization (`InvokeOptions.isOperator`). */
export const actsForOperator = (operator: Operator) => (caller: Caller) =>
  operator.organizationId !== undefined && caller.organizationId === operator.organizationId

/**
 * Run `fn` in the operator organization, with the proof operator data functions require. Operator
 * operations are refused to anyone else before their handler runs (audience "operator"); this is
 * the same check again, as a proof.
 */
export function inOperatorOrg<T>(
  caller: Caller,
  operator: Operator,
  fn: <O>(org: Named<O, OrganizationId>, proof: OperatorOrg<O>) => Promise<T>,
): Promise<T> {
  return name(OrganizationId(caller.organizationId), (org) => {
    const proof = operatorOrg(caller, org, operator.organizationId)
    if (!proof) throw new AppError("FORBIDDEN", "Only the operator organization can do this")
    return fn(org, proof)
  })
}

/**
 * The proof that row `id` exists in `org`, from the prover for its kind (`projectInOrg`, `runInOrg`,
 * ...), or NOT_FOUND. A missing row and another organization's row get the same answer, so
 * existence doesn't leak across tenants. The result is the prover's own proof type.
 */
export async function requireInOrg<T extends string, X, O, P>(
  prove: (db: Database, id: Named<X, T>, org: Named<O, OrganizationId>) => Promise<P | null>,
  db: Database,
  id: Named<X, T>,
  org: Named<O, OrganizationId>,
  label: string,
): Promise<P> {
  const proof = await prove(db, id, org)
  if (!proof) throw new AppError("NOT_FOUND", `${label} not found`)
  return proof
}

/**
 * What a data function returned after its proof was obtained: NOT_FOUND if it came back empty (the
 * row vanished between the two queries). Same falsy test as the `if (!row) throw` it replaces.
 */
export function orNotFound<T>(found: T, label: string): NonNullable<T> {
  if (!found) throw new AppError("NOT_FOUND", `${label} not found`)
  return found
}
