// SCIM provisioning (better-auth 1.7) has no HTTP endpoint that mints a token: its managed-connection
// endpoints are server-only. This one lets an organization's owner mint one. It creates a managed
// connection whose provisioning domain is the organization, and returns the bearer credential once: only
// its digest is stored. Impersonated sessions are refused (guards.ts), since a token outlives the session.
import { createHmac, randomUUID } from "node:crypto"
import { allowed } from "@proof/api"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api"
import { findMember } from "./membership"
import { rolePermissions } from "./permissions"

/** What a provisioning token may do: the SCIM users and groups the directory manages. */
export const SCIM_SCOPES = [
  "scim.users.read",
  "scim.users.write",
  "scim.groups.read",
  "scim.groups.write",
] as const

/** A token lasts a year; the owner mints a new one before it lapses. */
const TOKEN_DAYS = 365

/** The actor recorded when the product ends access on someone's behalf (a removal or a leave). */
export const ACCESS_ENDED_ACTOR = "proof:access-ended"

/**
 * The scim plugin's server-only managed-connection calls (see auth index.ts). A token is one
 * credential of a managed connection; revoking the credential is what ends it.
 */
export interface ScimManagement {
  list: (provisioningDomainId: string) => Promise<{
    connections: { connectionId: string; createdBy: string; status: string }[]
  }>
  get: (input: { connectionId: string; provisioningDomainId: string }) => Promise<{
    credentials: { credentialId: string; status: string }[]
  }>
  revokeCredential: (input: {
    connectionId: string
    provisioningDomainId: string
    credentialId: string
    actorId: string
  }) => Promise<unknown>
}

/**
 * Ends the SCIM tokens a person minted for an organization: revokes each active credential of the
 * connections they created there. A revoked credential no longer authenticates (the plugin's bearer
 * check requires an active one), so the next SCIM request gets 401. The connection and the users it
 * provisioned stay as they are: a token's end doesn't deprovision the directory's people. Run when
 * the person is removed, leaves, is demoted below the role that may mint tokens, or is deleted.
 */
export async function endScimTokensOf(
  scim: ScimManagement,
  userId: string,
  organizationId: string,
): Promise<void> {
  const { connections } = await scim.list(organizationId)
  for (const connection of connections) {
    if (connection.createdBy !== userId || connection.status !== "active") continue
    const { credentials } = await scim.get({
      connectionId: connection.connectionId,
      provisioningDomainId: organizationId,
    })
    for (const credential of credentials) {
      if (credential.status !== "active") continue
      await scim.revokeCredential({
        connectionId: connection.connectionId,
        provisioningDomainId: organizationId,
        credentialId: credential.credentialId,
        actorId: ACCESS_ENDED_ACTOR,
      })
    }
  }
}

export interface ScimConnectionInput {
  body: {
    creationRequestId: string
    provisioningDomainId: string
    actorId: string
    scopes: readonly (typeof SCIM_SCOPES)[number][]
    expiresAt: Date
  }
}

export interface ScimConnection {
  token: string
  connection: { connectionId: string }
}

/**
 * The digest key for managed SCIM credentials. Independent of the auth secret's own uses, so it's derived
 * from it under a label rather than configured separately.
 */
export const scimCredentialHashSecret = (secret: string) =>
  createHmac("sha256", secret).update("proof-scim-credential-hash").digest("hex")

export const scimTokenPlugin = (opts: {
  /** The scim plugin's server-only managed-connection call (see auth index.ts). */
  connect: (input: ScimConnectionInput) => Promise<ScimConnection>
}) =>
  ({
    id: "proof-scim-token",
    endpoints: {
      generateScimToken: createAuthEndpoint(
        "/scim/generate-token",
        { method: "POST" },
        async (ctx) => {
          const session = await getSessionFromCtx(ctx)
          if (!session)
            throw APIError.from("UNAUTHORIZED", { message: "Sign in first", code: "UNAUTHORIZED" })

          const organizationId = (ctx.body as { organizationId?: unknown } | undefined)
            ?.organizationId
          if (typeof organizationId !== "string" || organizationId === "") {
            throw APIError.from("BAD_REQUEST", {
              message: "organizationId is required",
              code: "ORGANIZATION_REQUIRED",
            })
          }
          const member = await findMember(ctx.context.adapter, session.user.id, organizationId)
          if (!member || !allowed(rolePermissions(member.role), { scim: ["create"] })) {
            throw APIError.from("FORBIDDEN", {
              message: "Only an organization owner can generate a SCIM token",
              code: "ORGANIZATION_OWNER_REQUIRED",
            })
          }

          const created = await opts.connect({
            body: {
              creationRequestId: randomUUID(),
              provisioningDomainId: organizationId,
              actorId: session.user.id,
              scopes: SCIM_SCOPES,
              expiresAt: new Date(Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000),
            },
          })
          return ctx.json({
            token: created.token,
            connectionId: created.connection.connectionId,
            expiresInDays: TOKEN_DAYS,
          })
        },
      ),
    },
  }) satisfies BetterAuthPlugin
