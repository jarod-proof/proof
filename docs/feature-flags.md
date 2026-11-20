# Feature flags

Release a change to a few organizations, then a percentage of all of them, then everyone, and take
the flag out of the code once the decision is made. The model follows
[OpenFeature](https://openfeature.dev) (CNCF) and the evaluation rules of
[flagd](https://flagd.dev) and Spotify's [Confidence](https://confidence.spotify.com), whose
[open-source resolver](https://github.com/spotify/confidence-resolver) and
[cleanup scans](https://confidence.spotify.com/docs/flags/flag-cleanup) shaped the stale signals.
Agents follow the lifecycle in `.claude/skills/feature-flags/SKILL.md`; words are in `GLOSSARY.md`.

## Pieces

| Piece | Where |
|---|---|
| The catalog: each flag's key, description, owner, default, `reclaimBy` | `packages/flags/src/catalog.ts` (`defineFlags`) |
| The evaluator, the bucketing and the stale signals (browser-safe, no I/O) | `packages/flags` |
| Rollouts, targets and exposure counts | tables `feature_flag`, `feature_flag_target`, `feature_flag_exposure_daily` (migration `0012_feature_flags`) |
| The operator operations (`list`, `get`, `update`, `target`, `untarget`, `reclaim`, `delete` `_feature_flag`) | `apps/api/src/operations/feature-flags.ts` |
| Evaluation for a caller: cache, targets, exposures, errors | `apps/api/src/flags.ts` (`FlagService`, `deps.flags`) |
| OFREP | `apps/api/src/ofrep.ts` |
| The web app's OpenFeature provider and `useFlag` | `apps/app` (see `docs/web-app.md`) |
| `pnpm flags refs [key]`, `pnpm flags stale [--check]` | `scripts/flags.mjs` |

## Who manages flags

The **operator organization** (`OPERATOR_ORGANIZATION_ID`) is the one that runs the product. The
operator operations carry `audience: "operator"` (`packages/api`): every other organization gets
FORBIDDEN before its permissions are read, never sees them as MCP tools, and doesn't find them in
`llms.txt`. OpenAPI lists them with `x-audience: operator` for the operator's own CLI and SDK.
Within the operator organization they need the `featureFlag` permission (`read`, `update`,
`delete`): owners and admins hold it, OAuth `read`/`write`/`admin` grant read/update/delete, and an
`sk_` key can carry it. Writes are audited like any other operation. Unset, rollouts are served
but nobody can change one. In the web app, the operator organization's members manage rollouts in
the admin console at `/admin/flags` (`docs/web-app.md`).

## Evaluation

For one flag and one organization, first match wins:

1. Reclaimed: the reclaimed value, for everyone (`STATIC`).
2. No rollout, or the kill switch off (`enabled: false`): the code default (`DISABLED`).
3. The organization is a target: the target's value, true (allow-list) or false (deny-list)
   (`TARGETING_MATCH`).
4. Its **bucket**, `floor(murmur3("<key>/<organizationId>") / 2^32 * 10000)`, under
   `percentage * 100`: true, else false (`SPLIT`; `STATIC` at 0 and 100).

The targeting key is always the caller's organization. A client's `targetingKey` is ignored, so no
one reads another organization's flags. Buckets are per flag and fixed, so raising the percentage
only adds organizations.

- **In the API:** `deps.flags.isEnabled(caller, "<key>")`. The key is typed from the catalog. On a
  database error it returns the code default and reports the error (OpenFeature's rule).
- **Over OFREP:** `POST /ofrep/v1/evaluate/flags` (all flags, with a weak `ETag`; `If-None-Match`
  answers 304) and `POST /ofrep/v1/evaluate/flags/:key` (404 `FLAG_NOT_FOUND` for an undeclared key).
  It takes any credential `resolvePrincipal` takes, and is CORS-open like `/v1`. Any OpenFeature
  SDK's OFREP provider works against it. It sits outside the registry because OFREP fixes its
  paths, error bodies and caching, as `/api/auth/*` sits outside it for OAuth. It is not metered.
- **Caching:** rollouts are cached for 5 seconds per process (`ROLLOUT_TTL_MS`), and a write on
  the same process clears it. Targets are read per evaluation set.

## Evidence

Every evaluation is an **exposure**, counted per flag, value and UTC day. They are written every 30
seconds and on SIGTERM, and kept 90 days (`pnpm --filter @proof/api-app cleanup`). The flags a
request evaluates are remembered for it. If it ends in a 5xx, each value it saw gets an `errors`
count, and the error report carries `flags: { key: value }`. `get_feature_flag` returns the days.
`list_feature_flags` returns the 7-day totals and the stale signals: `expired`, `inactive`,
`single-value`, `reclaimed-in-code`, `orphaned`.

Errors are attributed to flags read in the same API request. A flag read only in the browser gets
its evidence from the browser: e2e journeys, and client error reports.

## Lifecycle

Declare, then gate the code and ship. Target organizations, ramp, and watch the evidence. Then
reclaim, remove the code and ship, and delete the rollout. The guards:

- A reclaimed rollout can't change (CONFLICT): the decision is final.
- `delete_feature_flag` is refused while the running code declares the flag. Deleting a rollout
  early would send every organization back to the code default.
- Removing a flag from the catalog turns each remaining read into a compile error.

## Template example

`whats-new-card` gates the "What's new" card on the organization home. Reclaiming it and removing
it is a quick walkthrough of the whole lifecycle. The tests and operation examples don't depend on
it.
