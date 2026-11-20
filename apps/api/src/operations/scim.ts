import { AppError } from "@proof/errors"
import { z } from "zod"

import { listScimTokens } from "../data/scim"
import { inCallerOrg, orNotFound } from "../tenant"
import { defineOperation, type OperationDeps } from "./shared"

// SCIM tokens are owner-only and person-only (the scim resource in the catalog): keys and OAuth tokens
// never hold them, so these operations are for a person signed in to the web app.
export function scimOperations({ auth, db }: Pick<OperationDeps, "auth" | "db">) {
  const list_scim_tokens = defineOperation({
    name: "list_scim_tokens",
    method: "GET",
    path: "/v1/scim/tokens",
    summary: "List the organization's SCIM tokens (no secrets)",
    description:
      "Lists the SCIM provisioning tokens minted for the caller's organization, newest first: id, " +
      "who minted each and when, when it was last used (null if never) and when it expires. The token " +
      "itself is shown once, at minting, and never again. Use the id with revoke_scim_token to end one. " +
      "Owners only (scim:read).",
    permissions: { scim: ["read"] },
    input: z.object({}),
    output: z.object({
      tokens: z.array(
        z.object({
          id: z.string().describe("Use with revoke_scim_token"),
          createdAt: z.string(),
          createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
          lastUsedAt: z.string().nullable(),
          expiresAt: z.string().nullable(),
        }),
      ),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: (_input, { caller }) =>
      inCallerOrg(caller, async (org, proof) => ({
        tokens: (await listScimTokens(db, org, proof)).map((t) => ({
          id: t.id,
          createdAt: t.createdAt.toISOString(),
          createdBy: t.createdBy,
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          expiresAt: t.expiresAt?.toISOString() ?? null,
        })),
      })),
  })

  const revoke_scim_token = defineOperation({
    name: "revoke_scim_token",
    method: "DELETE",
    path: "/v1/scim/tokens/:id",
    summary: "Revoke a SCIM token",
    description:
      "Ends a SCIM provisioning token: its next request gets 401. The people it already provisioned " +
      "stay members; removing them is done by removing the member. Returns NOT_FOUND for ids that aren't " +
      "live SCIM tokens of this organization. Owners only (scim:delete). Confirm with the user first.",
    permissions: { scim: ["delete"] },
    fresh: true,
    input: z.object({ id: z.string().describe("Token id from list_scim_tokens") }),
    output: z.object({ revoked: z.literal(true) }),
    hints: { readOnly: false, destructive: true },
    examples: [{ input: { id: "ba_scim_connection_00000000" }, error: "NOT_FOUND" }],
    handler: ({ id }, { caller }) =>
      inCallerOrg(caller, async (org, proof) => {
        if (caller.actor.type !== "user") {
          throw new AppError("FORBIDDEN", "Only a person can revoke a SCIM token")
        }
        const token = orNotFound(
          (await listScimTokens(db, org, proof)).find((t) => t.id === id),
          "SCIM token",
        )
        for (const credentialId of token.credentialIds) {
          await auth.api.revokeSCIMManagedCredential({
            body: {
              connectionId: id,
              provisioningDomainId: org.value,
              credentialId,
              actorId: caller.actor.userId,
            },
          })
        }
        return { revoked: true as const }
      }),
  })

  return { list_scim_tokens, revoke_scim_token }
}
