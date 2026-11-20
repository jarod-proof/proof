// Feature flag rollouts, for the operator organization only (audience "operator"). A flag is
// declared in code (packages/flags); these operations decide who sees it: target organizations,
// ramp a percentage, pause, reclaim, delete. The lifecycle an agent follows is in
// .claude/skills/feature-flags/SKILL.md.
import {
  FeatureFlagKey,
  flagInOrg,
  type Named,
  name,
  type OperatorOrg,
  type OrganizationId,
} from "@proof/auth-proofs"
import { AppError } from "@proof/errors"
import {
  dayBefore,
  type ExposureDay,
  type FlagDefinition,
  INACTIVE_DAYS,
  SINGLE_VALUE_DAYS,
  staleSignals,
} from "@proof/flags"
import { z } from "zod"

import {
  deleteRollout,
  exposuresSince,
  type ExposureCount,
  getRollout,
  listRollouts,
  listTargets,
  type ManagedRollout,
  reclaimRollout,
  removeTargets,
  resolveOrganizations,
  saveRollout,
  setTargets,
} from "../data/feature-flags"
import type { FlagService } from "../flags"
import { inOperatorOrg, type Operator, orNotFound, requireInOrg } from "../tenant"
import { defineOperation, type OperationDeps } from "./shared"

const keyInput = z
  .string()
  .min(1)
  .max(64)
  .describe("Flag key, as list_feature_flags shows it (kebab-case, declared in code)")

const exposureSummary = z
  .object({
    on: z.number().int().describe("Evaluations that served true"),
    off: z.number().int().describe("Evaluations that served false"),
    errorsOn: z
      .number()
      .int()
      .describe("API requests that evaluated it to true and then failed with a 5xx"),
    errorsOff: z
      .number()
      .int()
      .describe("API requests that evaluated it to false and then failed with a 5xx"),
  })
  .describe("Counts over the last 7 UTC days, across every organization")

const flagOutput = z.object({
  key: z.string(),
  description: z.string().nullable().describe("Null once the code no longer declares it"),
  owner: z.string().nullable(),
  default: z.boolean().nullable().describe("The code default; null once undeclared"),
  reclaimBy: z.string().nullable().describe("The day it should be reclaimed by (YYYY-MM-DD)"),
  inCatalog: z.boolean().describe("Whether the running code declares it"),
  status: z
    .enum(["off", "targeting", "ramping", "on", "paused", "reclaimed", "orphaned"])
    .describe(
      "off: no rollout, or 0% and no targets on. targeting: only its targets. ramping: a " +
        "percentage between 0 and 100. on: 100%. paused: the kill switch is off (everyone gets " +
        "the default). reclaimed: decided, serving reclaimedValue to everyone. orphaned: the code " +
        "no longer declares it; delete the rollout.",
    ),
  enabled: z.boolean().describe("The kill switch; false serves the default to everyone"),
  percentage: z.number().int().describe("Percent of non-target organizations that get true"),
  targetsOn: z.number().int().describe("Organizations turned on by a target"),
  targetsOff: z.number().int().describe("Organizations turned off by a target"),
  reclaimedValue: z.boolean().nullable(),
  reclaimedAt: z.string().nullable(),
  updatedAt: z.string().nullable().describe("When the rollout last changed; null with no rollout"),
  exposures: exposureSummary,
  stale: z
    .array(z.enum(["expired", "inactive", "single-value", "reclaimed-in-code", "orphaned"]))
    .describe(
      "Why it should be removed: expired (past reclaimBy), inactive (no evaluations in 30 " +
        "days), single-value (one value served for 7 days), reclaimed-in-code (reclaimed but " +
        "still declared: remove the code), orphaned (undeclared: delete the rollout)",
    ),
})

const targetOutput = z.object({
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  value: z.boolean().describe("true: turned on for it (allow-list); false: turned off (deny-list)"),
  createdAt: z.string(),
})

type Flag = z.input<typeof flagOutput>

function status(def: FlagDefinition | undefined, r: ManagedRollout | null): Flag["status"] {
  if (!def) return "orphaned"
  if (!r) return "off"
  if (r.reclaimedValue !== null) return "reclaimed"
  if (!r.enabled) return "paused"
  if (r.percentage >= 100) return "on"
  if (r.percentage > 0) return "ramping"
  return r.targetsOn > 0 ? "targeting" : "off"
}

function summarize(exposures: readonly ExposureCount[], now: Date) {
  const week = exposures.filter((e) => e.day > dayBefore(now, SINGLE_VALUE_DAYS))
  const sum = (value: boolean, field: "count" | "errors") =>
    week.filter((e) => e.value === value).reduce((n, e) => n + e[field], 0)
  return {
    on: sum(true, "count"),
    off: sum(false, "count"),
    errorsOn: sum(true, "errors"),
    errorsOff: sum(false, "errors"),
  }
}

function toFlag(
  key: string,
  def: FlagDefinition | undefined,
  rollout: ManagedRollout | null,
  exposures: readonly ExposureCount[],
  now: Date,
): Flag {
  const mine = exposures.filter((e) => e.key === key)
  const days: ExposureDay[] = mine.map(({ day, value, count }) => ({ day, value, count }))
  return {
    key,
    description: def?.description ?? null,
    owner: def?.owner ?? null,
    default: def?.default ?? null,
    reclaimBy: def?.reclaimBy ?? null,
    inCatalog: def !== undefined,
    status: status(def, rollout),
    enabled: rollout?.enabled ?? true,
    percentage: rollout?.percentage ?? 0,
    targetsOn: rollout?.targetsOn ?? 0,
    targetsOff: rollout?.targetsOff ?? 0,
    reclaimedValue: rollout?.reclaimedValue ?? null,
    reclaimedAt: rollout?.reclaimedAt?.toISOString() ?? null,
    updatedAt: rollout?.updatedAt.toISOString() ?? null,
    exposures: summarize(mine, now),
    stale: staleSignals({
      inCatalog: def !== undefined,
      reclaimBy: def?.reclaimBy,
      reclaimed: rollout?.reclaimedValue != null,
      rolloutUpdatedAt: rollout?.updatedAt,
      exposures: days,
      now,
    }),
  }
}

const notDeclared = (key: string) =>
  new AppError("NOT_FOUND", `No flag ${key} in the running code`, {
    hint: "Declare it with defineFlags in packages/flags/src/catalog.ts and deploy, then roll it out. list_feature_flags shows the declared keys.",
  })

const reclaimed = (key: string) =>
  new AppError("CONFLICT", `Flag ${key} is reclaimed; its rollout can't change`, {
    hint: "A reclaimed flag serves its reclaimedValue to everyone. Remove it from the code, deploy, then call delete_feature_flag.",
  })

export function featureFlagOperations({
  db,
  now,
  operator,
  flags,
}: Pick<OperationDeps, "db" | "now"> & { operator: Operator; flags: FlagService }) {
  const catalog = flags.catalog

  const list_feature_flags = defineOperation({
    name: "list_feature_flags",
    method: "GET",
    path: "/v1/feature-flags",
    audience: "operator",
    summary: "List feature flags with their rollout and stale signals",
    description:
      "Returns every flag the running code declares, plus any rollout whose flag the code no " +
      "longer declares (status orphaned), each with its status, percentage, target counts, the " +
      "last 7 days of evaluations and 5xx errors per value, and its stale signals. Pass " +
      "stale=true for only the flags due for removal. Use get_feature_flag for one flag's targets.",
    permissions: { featureFlag: ["read"] },
    input: z.object({
      stale: z.coerce
        .boolean()
        .optional()
        .describe("true: only flags with at least one stale signal"),
    }),
    output: z.object({ flags: z.array(flagOutput) }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: (input, { caller }) =>
      inOperatorOrg(caller, operator, async (org, proof) => {
        const at = now()
        const [rollouts, exposures] = await Promise.all([
          listRollouts(db, org, proof),
          exposuresSince(db, org, proof, dayBefore(at, INACTIVE_DAYS)),
        ])
        const byKey = new Map(rollouts.map((r) => [r.key, r]))
        const keys = [...Object.keys(catalog), ...rollouts.map((r) => r.key)]
        const all = [...new Set(keys)].map((key) =>
          toFlag(key, catalog[key], byKey.get(key) ?? null, exposures, at),
        )
        return { flags: input.stale ? all.filter((f) => f.stale.length > 0) : all }
      }),
  })

  const get_feature_flag = defineOperation({
    name: "get_feature_flag",
    method: "GET",
    path: "/v1/feature-flags/:key",
    audience: "operator",
    summary: "Get one flag with its targets and daily evaluations",
    description:
      "Returns the flag as list_feature_flags does, plus its target organizations (id, name, " +
      "slug, value) and its evaluations and 5xx errors per UTC day and value for the last 30 " +
      "days. Compare errors per evaluation between true and false before ramping further or " +
      "reclaiming. NOT_FOUND when neither the code nor a rollout has the key.",
    permissions: { featureFlag: ["read"] },
    input: z.object({ key: keyInput }),
    output: flagOutput.extend({
      targets: z.array(targetOutput),
      days: z.array(
        z.object({
          day: z.string(),
          value: z.boolean(),
          count: z.number().int(),
          errors: z.number().int(),
        }),
      ),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: { key: "new-checkout" }, error: "NOT_FOUND" }],
    handler: ({ key }, { caller }) =>
      inOperatorOrg(caller, operator, async (org, proof) => {
        const at = now()
        const [rollout, exposures] = await Promise.all([
          getRollout(db, key, org, proof),
          exposuresSince(db, org, proof, dayBefore(at, INACTIVE_DAYS), key),
        ])
        const def = catalog[key]
        if (!def && !rollout) throw notDeclared(key)
        const targets = rollout
          ? await name(FeatureFlagKey(key), async (flagKey) => {
              const inOrg = await requireInOrg(flagInOrg, db, flagKey, org, "Flag")
              return listTargets(db, flagKey, org, { inOrg, operator: proof })
            })
          : []
        return {
          ...toFlag(key, def, rollout, exposures, at),
          targets: targets.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
          days: exposures.map(({ day, value, count, errors }) => ({ day, value, count, errors })),
        }
      }),
  })

  /** The flag after a write, as get would show it without targets. */
  async function current<O>(key: string, org: Named<O, OrganizationId>, proof: OperatorOrg<O>) {
    const at = now()
    const [rollout, exposures] = await Promise.all([
      getRollout(db, key, org, proof),
      exposuresSince(db, org, proof, dayBefore(at, INACTIVE_DAYS), key),
    ])
    return toFlag(key, catalog[key], rollout, exposures, at)
  }

  const update_feature_flag = defineOperation({
    name: "update_feature_flag",
    method: "PATCH",
    path: "/v1/feature-flags/:key",
    audience: "operator",
    summary: "Ramp a flag's percentage, or pause and resume it",
    description:
      "Sets the percentage of all non-target organizations that get true (each keeps a fixed " +
      "bucket, so raising it only adds organizations), and/or the kill switch: enabled=false " +
      "serves the code default to everyone, targets included, until enabled=true. Creates the " +
      "rollout if the flag has none. Ramp in steps (1, 5, 25, 50, 100) and check get_feature_flag " +
      "between them. CONFLICT once reclaimed; NOT_FOUND for a key the code doesn't declare.",
    permissions: { featureFlag: ["update"] },
    input: z.object({
      key: keyInput,
      percentage: z.number().int().min(0).max(100).optional().describe("0 to 100, whole percent"),
      enabled: z.boolean().optional().describe("The kill switch: false pauses the rollout"),
    }),
    output: flagOutput,
    hints: { readOnly: false, destructive: false, idempotent: true },
    examples: [{ input: { key: "new-checkout", percentage: 5 }, error: "NOT_FOUND" }],
    handler: ({ key, percentage, enabled }, { caller }) =>
      inOperatorOrg(caller, operator, async (org, proof) => {
        if (!catalog[key]) throw notDeclared(key)
        const saved = await saveRollout(db, key, org, proof, { percentage, enabled }, now())
        if (!saved) throw reclaimed(key)
        flags.invalidate()
        return current(key, org, proof)
      }),
  })

  const target_feature_flag = defineOperation({
    name: "target_feature_flag",
    method: "POST",
    path: "/v1/feature-flags/:key/targets",
    audience: "operator",
    summary: "Turn a flag on (or off) for named organizations",
    description:
      "Adds organizations, by id or slug, to the flag's targets: value true turns it on for them " +
      "whatever the percentage (an allow-list, the first step of a rollout), false turns it off " +
      "for them (a deny-list, to take one organization out of a ramp). Re-targeting changes the " +
      "value. Creates the rollout if the flag has none. BAD_REQUEST names organizations that " +
      "don't exist; CONFLICT once reclaimed.",
    permissions: { featureFlag: ["update"] },
    input: z.object({
      key: keyInput,
      organizations: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .describe("Organization ids or slugs, 1 to 100"),
      value: z.boolean().default(true).describe("true (default): on for them; false: off"),
    }),
    output: flagOutput,
    hints: { readOnly: false, destructive: false, idempotent: true },
    examples: [
      { input: { key: "new-checkout", organizations: ["acme"], value: true }, error: "NOT_FOUND" },
    ],
    handler: ({ key, organizations, value }, { caller }) =>
      inOperatorOrg(caller, operator, async (org, proof) => {
        if (!catalog[key]) throw notDeclared(key)
        const ids = await resolveOrganizations(db, org, proof, organizations)
        if (!(await saveRollout(db, key, org, proof, {}, now()))) throw reclaimed(key)
        await name(FeatureFlagKey(key), async (flagKey) => {
          const inOrg = await requireInOrg(flagInOrg, db, flagKey, org, "Flag")
          await setTargets(db, flagKey, org, { inOrg, operator: proof }, ids, value, now())
        })
        flags.invalidate()
        return current(key, org, proof)
      }),
  })

  const untarget_feature_flag = defineOperation({
    name: "untarget_feature_flag",
    method: "DELETE",
    path: "/v1/feature-flags/:key/targets/:organization",
    audience: "operator",
    summary: "Remove an organization from a flag's targets",
    description:
      "Removes one organization (by id or slug) from the flag's targets, so the percentage " +
      "decides for it again. Answers with the flag; removed is false if it was not a target. " +
      "CONFLICT once reclaimed.",
    permissions: { featureFlag: ["update"] },
    input: z.object({
      key: keyInput,
      organization: z.string().min(1).describe("Organization id or slug"),
    }),
    output: flagOutput.extend({ removed: z.boolean() }),
    hints: { readOnly: false, destructive: true, idempotent: true },
    examples: [{ input: { key: "new-checkout", organization: "acme" }, error: "NOT_FOUND" }],
    handler: ({ key, organization }, { caller }) =>
      inOperatorOrg(caller, operator, async (org, proof) => {
        const rollout = await getRollout(db, key, org, proof)
        if (!rollout) throw notDeclared(key)
        if (rollout.reclaimedValue !== null) throw reclaimed(key)
        const ids = await resolveOrganizations(db, org, proof, [organization])
        const removed = await name(FeatureFlagKey(key), async (flagKey) => {
          const inOrg = await requireInOrg(flagInOrg, db, flagKey, org, "Flag")
          return removeTargets(db, flagKey, org, { inOrg, operator: proof }, ids, now())
        })
        flags.invalidate()
        return { ...(await current(key, org, proof)), removed: removed > 0 }
      }),
  })

  const reclaim_feature_flag = defineOperation({
    name: "reclaim_feature_flag",
    method: "POST",
    path: "/v1/feature-flags/:key/reclaim",
    audience: "operator",
    summary: "End a rollout: serve one value to everyone, for good",
    description:
      "Records the decision a rollout was for: every organization gets `value` from now on, " +
      "whatever the targets, percentage or kill switch, and the rollout can no longer change. " +
      "Then remove the flag from the code (replacing each read with `value`), deploy, and call " +
      "delete_feature_flag. Not reversible: confirm with the user first, with the evidence " +
      "(get_feature_flag: evaluations and errors per value). CONFLICT if already reclaimed.",
    permissions: { featureFlag: ["update"] },
    input: z.object({
      key: keyInput,
      value: z.boolean().describe("The value everyone keeps: true to keep the feature"),
    }),
    output: flagOutput,
    hints: { readOnly: false, destructive: true },
    examples: [{ input: { key: "new-checkout", value: true }, error: "NOT_FOUND" }],
    handler: ({ key, value }, { caller }) =>
      inOperatorOrg(caller, operator, async (org, proof) => {
        if (!catalog[key]) throw notDeclared(key)
        if (!(await saveRollout(db, key, org, proof, {}, now()))) throw reclaimed(key)
        await name(FeatureFlagKey(key), async (flagKey) => {
          const inOrg = await requireInOrg(flagInOrg, db, flagKey, org, "Flag")
          const row = await reclaimRollout(
            db,
            flagKey,
            org,
            { inOrg, operator: proof },
            value,
            now(),
          )
          if (!row) throw reclaimed(key)
        })
        flags.invalidate()
        return current(key, org, proof)
      }),
  })

  const delete_feature_flag = defineOperation({
    name: "delete_feature_flag",
    method: "DELETE",
    path: "/v1/feature-flags/:key",
    audience: "operator",
    summary: "Delete the rollout of a flag the code no longer declares",
    description:
      "Deletes a flag's rollout and targets: the last step, after the flag is reclaimed, removed " +
      "from the code, and that code is deployed (status orphaned). CONFLICT while the running " +
      "code still declares it, since deleting the rollout would drop every organization back to " +
      "the code default. NOT_FOUND if it has no rollout.",
    permissions: { featureFlag: ["delete"] },
    input: z.object({ key: keyInput }),
    output: z.object({ deleted: z.literal(true) }),
    hints: { readOnly: false, destructive: true },
    examples: [{ input: { key: "new-checkout" }, error: "NOT_FOUND" }],
    handler: ({ key }, { caller }) =>
      inOperatorOrg(caller, operator, async (org, proof) => {
        if (catalog[key]) {
          throw new AppError("CONFLICT", `The running code still declares ${key}`, {
            hint: "Reclaim it, remove it from packages/flags/src/catalog.ts and every call site, deploy, then delete the rollout.",
          })
        }
        orNotFound(await getRollout(db, key, org, proof), "Flag rollout")
        await name(FeatureFlagKey(key), async (flagKey) => {
          const inOrg = await requireInOrg(flagInOrg, db, flagKey, org, "Flag rollout")
          await deleteRollout(db, flagKey, org, { inOrg, operator: proof })
        })
        flags.invalidate()
        return { deleted: true as const }
      }),
  })

  return {
    list_feature_flags,
    get_feature_flag,
    update_feature_flag,
    target_feature_flag,
    untarget_feature_flag,
    reclaim_feature_flag,
    delete_feature_flag,
  }
}
