---
name: feature-flags
description: Release a change behind a feature flag in this repo and carry it through its lifecycle: declare the flag, gate the code, target allow-listed organizations, ramp a percentage, check the evidence, reclaim it, remove the code, delete the rollout. Use when shipping something risky or gradual, adding, ramping, pausing or reclaiming a flag, cleaning up stale flags (`pnpm flags stale`), or touching packages/flags, the operator operations or /ofrep.
---

# Feature flags

A **flag** is declared in code (`packages/flags/src/catalog.ts`); its **rollout** is runtime state
that the operator organization changes through the operator operations. Words as in `GLOSSARY.md`
(Feature flags). How it works: `docs/feature-flags.md`.

**Credential.** Rollout operations answer only to the **operator organization**
(`OPERATOR_ORGANIZATION_ID`; `whoami` says `operator: true`): an `sk_` key of that organization with
`featureFlag` permissions, or an OAuth token in it (`write` ramps, `admin` also deletes). Call them as
MCP tools or with `proof call <operation> --json '{...}'`. A person in that organization does the
same in the web app's admin console, `/admin/flags`.

**Evidence** is what `get_feature_flag` returns: evaluations and 5xx errors per value per day
(`days`), the 7-day totals (`exposures`), and the targets. An error report names the flags its
request evaluated (`flags` in the report context). The error rate of a value is its errors over
its evaluations; a value is **healthy** when its rate is no higher than the other value's.

## Lifecycle

Each step ends on its check. Hold the release at the first check that fails.

1. **Declare.** Add the flag to `catalog.ts` with `defineFlags`: kebab-case key, a description of
   what turning it on changes, `owner`, `default: false`, `reclaimBy` a few weeks out. Gate the code:
   `flags.isEnabled(caller, "<key>")` in an API handler (`deps.flags`), `useFlag("<key>")` in the
   web app. Keep both paths working and tested.
   *Check:* `pnpm flags refs <key>` lists every gated call site; the done-chain passes; it ships.
2. **Target.** `target_feature_flag` with the operator organization first, then the allow-listed
   organizations the user names (ids or slugs).
   *Check:* `get_feature_flag` shows `status: targeting` and exactly those targets; a target sees the
   new path.
3. **Ramp.** `update_feature_flag` with `percentage` 1, 5, 25, 50, then 100. Between steps, hold for
   the window the user set (a day if none) and read the evidence. An organization that must wait gets
   a `value: false` target. A regression: `update_feature_flag` with `enabled: false` (everyone gets
   the default at once), then report it with the evidence.
   *Check, per step:* the true value is healthy, and no new error report names the flag.
4. **Reclaim.** Show the user the evidence and the value to keep; reclaim only on their yes:
   `reclaim_feature_flag` with that `value`. It is final.
   *Check:* `status: reclaimed`, `stale` includes `reclaimed-in-code`.
5. **Remove the code.** Delete the flag from `catalog.ts`. `pnpm typecheck` now names every read:
   replace each with the reclaimed value, delete the branch that can no longer run and its tests.
   *Check:* `pnpm flags refs <key>` finds nothing; the done-chain passes; it ships.
6. **Delete the rollout.** After that deploy, the flag shows `status: orphaned`:
   `delete_feature_flag`. Earlier it answers CONFLICT, since the running code still reads it.
   *Check:* `get_feature_flag` answers NOT_FOUND.

## Stale sweep

`pnpm flags stale` lists the flags due for removal, each signal with its next step and the code
references (with `PROOF_API_URL` and `PROOF_API_KEY` set it reads the rollouts; else only
`expired` and `unused`). `--check` exits 1 when anything is stale. Per signal:

- `orphaned`: step 6.
- `reclaimed-in-code`: step 5.
- `single-value`: it serves one value; with the user, reclaim it with that value (step 4).
- `inactive`: nothing evaluated it for 30 days; its code is dead or unreachable: steps 4 to 6.
- `expired` (past `reclaimBy`): ask the user to finish the ramp, reclaim, or move `reclaimBy` with a
  reason in the catalog comment.
- `unused` (declared, never read): remove it from the catalog, or gate the code it was for.
