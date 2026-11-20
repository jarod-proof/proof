import { paginated, paginationInput } from "@proof/api"
import { z } from "zod"

import { listAuditEvents } from "../data/audit"
import { inCallerOrg } from "../tenant"
import { actorType, cut, defineOperation, type OperationDeps, readCursor } from "./shared"

const auditEventOutput = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.object({ type: z.enum(["user", "apiKey"]), id: z.string() }),
  clientId: z.string().nullable(),
  operation: z.string(),
  outcome: z.string(),
  requestId: z.string().nullable(),
})

export function auditOperations({ db }: Pick<OperationDeps, "db">) {
  const list_audit_events = defineOperation({
    name: "list_audit_events",
    method: "GET",
    path: "/v1/audit-events",
    summary: "List who did what in this organization",
    description:
      "Lists recorded writes and refusals in this organization, newest first: the actor (a user or " +
      "an API key), the OAuth client if any, the operation, its outcome and the request id. Pass " +
      "nextCursor back as cursor for older events; it is null on the last page. Requires an " +
      "organization admin.",
    permissions: { organization: ["update"] },
    input: paginationInput,
    output: paginated("events", auditEventOutput),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: (input, { caller }) =>
      inCallerOrg(caller, async (org, proof) => {
        const rows = await listAuditEvents(db, org, proof, {
          after: readCursor(input.cursor),
          limit: input.limit + 1,
        })
        const { page, nextCursor } = cut(rows, input.limit, (e) => e.at)
        return {
          events: page.map((e) => ({
            id: e.id,
            at: e.at.toISOString(),
            actor: { type: actorType(e.actorType), id: e.actorId },
            clientId: e.clientId,
            operation: e.operation,
            outcome: e.outcome,
            requestId: e.requestId,
          })),
          nextCursor,
        }
      }),
  })

  return {
    list_audit_events,
  }
}
