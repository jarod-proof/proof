import { allowed } from "@proof/api"
import { PERSON_ONLY_ACTIONS, PERSON_ONLY_RESOURCES, statements } from "@proof/auth"
import { AppError } from "@proof/errors"
import { z } from "zod"

import { creatorOf, listApiKeys } from "../data/api-keys"
import { inCallerOrg } from "../tenant"
import { defineOperation, type OperationDeps } from "./shared"

const catalog: Readonly<Record<string, readonly string[]>> = statements

// What a key may never hold, from the catalog: owner-only and billing resources, and actions a
// person must decide (run:approve). Listed in the refusal's hint.
const personOnlyList = [
  ...PERSON_ONLY_RESOURCES,
  ...Object.entries(PERSON_ONLY_ACTIONS).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}`),
  ),
].join(", ")
const holdsPersonOnlyAction = (permissions: Record<string, string[]>) =>
  Object.entries(PERSON_ONLY_ACTIONS).some(([resource, actions]) =>
    (permissions[resource] ?? []).some((action) => (actions as readonly string[]).includes(action)),
  )

/** `{ resource: [actions] }`, limited to the permission catalog. */
const permissionsInput = z.record(z.string(), z.array(z.string()).min(1)).refine(
  (p) =>
    Object.entries(p).every(
      ([resource, actions]) =>
        // Own keys only: `constructor` or `toString` would otherwise find Object.prototype's.
        Object.hasOwn(catalog, resource) && actions.every((a) => catalog[resource]?.includes(a)),
    ),
  { message: "Unknown resource or action; see the permission catalog" },
)

export function apiKeyOperations({ auth, db }: Pick<OperationDeps, "auth" | "db">) {
  const create_api_key = defineOperation({
    name: "create_api_key",
    method: "POST",
    path: "/v1/api-keys",
    summary: "Create an organization API key",
    description:
      "Creates an API key for the caller's organization with the given permissions, which must be " +
      "within the caller's own. The key is returned once; store it securely. Only a signed-in user " +
      "(session or OAuth) can create keys, not another API key.",
    permissions: { apiKey: ["create"] },
    fresh: true,
    hints: { readOnly: false, destructive: false },
    input: z.object({
      name: z.string().trim().min(1).max(100).describe("What the key is for"),
      permissions: permissionsInput.describe(
        'Permissions for the key, e.g. { "project": ["read"] }',
      ),
      expiresInDays: z.number().int().min(1).max(365).optional().describe("Omit for no expiry"),
    }),
    output: z.object({
      id: z.string(),
      key: z.string(),
      permissions: z.record(z.string(), z.array(z.string())),
    }),
    examples: [{ input: { name: "CI", permissions: { project: ["read"] }, expiresInDays: 90 } }],
    handler: async ({ name: keyName, permissions, expiresInDays }, { caller }) => {
      if (caller.actor.type !== "user") {
        throw new AppError("FORBIDDEN", "API keys can't create API keys; sign in as a user")
      }
      // Owner-only and billing resources, and deciding approvals, are for people: a key never holds them.
      const restricted = Object.keys(permissions).filter((r) =>
        (PERSON_ONLY_RESOURCES as readonly string[]).includes(r),
      )
      if (restricted.length > 0 || holdsPersonOnlyAction(permissions)) {
        throw new AppError(
          "FORBIDDEN",
          "A key can't hold owner-only permissions or person-only actions",
          {
            hint: `Keys can't have these: ${personOnlyList}. Those are for a person signed in to the web app (owners; admins for subscription; support staff and customers for support).`,
          },
        )
      }
      // Checked against the caller's effective grants (role ∩ credential), so a read-only OAuth
      // token can't mint a key with more than it has.
      if (!allowed(caller.grants, permissions)) {
        throw new AppError("FORBIDDEN", "A key can't have permissions its creator doesn't have")
      }
      const created = await auth.api.createApiKey({
        body: {
          organizationId: caller.organizationId,
          userId: caller.actor.userId,
          name: keyName,
          permissions,
          expiresIn: expiresInDays ? expiresInDays * 86_400 : undefined,
          metadata: { createdBy: await creatorOf(db, caller.actor.userId) },
        },
      })
      return { id: created.id, key: created.key, permissions }
    },
  })

  const list_api_keys = defineOperation({
    name: "list_api_keys",
    method: "GET",
    path: "/v1/api-keys",
    summary: "List the organization's API keys (masked)",
    description:
      "Lists the organization's API keys, newest first: id, name, the masked start of the key (for telling " +
      "keys apart; the key itself is never shown again), its permissions, when it was created and who created " +
      "it (null for keys made before that was recorded), when it was last used, and when it expires (null for " +
      "no expiry). Use the id with revoke_agent_access to delete a key. Needs apiKey:read.",
    permissions: { apiKey: ["read"] },
    input: z.object({}),
    output: z.object({
      keys: z.array(
        z.object({
          id: z.string(),
          name: z.string().nullable(),
          start: z
            .string()
            .nullable()
            .describe("The first characters of the key, masked for display"),
          permissions: z.record(z.string(), z.array(z.string())),
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
        keys: (await listApiKeys(db, org, proof)).map((k) => ({
          id: k.id,
          name: k.name,
          start: k.start,
          permissions: k.permissions,
          createdAt: k.createdAt.toISOString(),
          createdBy: k.createdBy,
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          expiresAt: k.expiresAt?.toISOString() ?? null,
        })),
      })),
  })

  return {
    create_api_key,
    list_api_keys,
  }
}
