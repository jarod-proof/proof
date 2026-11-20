import { defineProof, type Named, type Proof } from "@gdp-ts/core"
import { type Database, featureFlag } from "@proof/db"
import { and, eq } from "drizzle-orm"
import type { FeatureFlagKey, OrganizationId } from "../lib/ids"

const FlagInOrg = defineProof("FlagInOrg")
/** The rollout of flag `K` exists and is managed by organization `O`. */
export interface FlagInOrg<K, O> extends Proof<"FlagInOrg", [K, O]> {}

export async function flagInOrg<K, O>(
  db: Database,
  key: Named<K, FeatureFlagKey>,
  org: Named<O, OrganizationId>,
): Promise<FlagInOrg<K, O> | null> {
  const [row] = await db
    .select({ key: featureFlag.key })
    .from(featureFlag)
    .where(and(eq(featureFlag.key, key.value), eq(featureFlag.organizationId, org.value)))
    .limit(1)
  return row ? FlagInOrg.prove(key, org) : null
}
