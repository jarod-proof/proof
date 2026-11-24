import { defineRegistry } from "@proof/api"
import { z } from "zod"

import { digestOperations } from "./digest"
import { entryOperations } from "./entries"
import { policyOperations } from "./policy"
import { proposalOperations } from "./proposals"
import { runOperations } from "./runs"
import { defineOperation, type HqDeps } from "./shared"
import { spendOperations } from "./spend"
import { statusOperations } from "./status"
import { workAttemptOperations } from "./work-attempts"
import { workFounderOperations } from "./work-founder"
import { workReadOperations } from "./work-read"
import { workSignalOperations } from "./work-signals"

export type { HqDeps } from "./shared"

/** hq's version: reported by `hq_status`, the OpenAPI document and the MCP server. */
export const HQ_VERSION = "0.0.0"

const hq_status = defineOperation({
  name: "hq_status",
  method: "GET",
  path: "/v1/status",
  summary: "Check that hq answers for this credential",
  description:
    "Returns { ok: true } and hq's version when the credential may read the brain. Call it first " +
    "to check a credential against hq.",
  permissions: { hq_entry: ["read"] },
  input: z.object({}),
  output: z.object({
    ok: z.literal(true),
    version: z.string().describe("hq's version"),
  }),
  hints: { readOnly: true },
  examples: [{ input: {}, output: { ok: true, version: "0.0.0" } }],
  handler: () => ({ ok: true as const, version: HQ_VERSION }),
})

/** Every operation hq serves: one registry for REST, MCP, OpenAPI and llms.txt. */
export function createHqOperations(deps: HqDeps) {
  return defineRegistry([
    hq_status,
    ...digestOperations(deps),
    ...entryOperations(deps),
    ...policyOperations(deps),
    ...proposalOperations(deps),
    ...runOperations(deps),
    ...spendOperations(deps),
    ...statusOperations(deps),
    ...workAttemptOperations(deps),
    ...workFounderOperations(deps),
    ...workReadOperations(deps),
    ...workSignalOperations(deps),
  ])
}
