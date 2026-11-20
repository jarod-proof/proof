import { intersect, type PermissionSet, type PermissionsOf, union } from "@proof/api"
import {
  type Catalog,
  PERSON_ONLY_ACTIONS,
  PERSON_ONLY_RESOURCES,
  type RoleName,
  roles,
  statements,
} from "./access"

export {
  ac,
  type Catalog,
  OWNER_ONLY_RESOURCES,
  PERSON_ONLY_ACTIONS,
  PERSON_ONLY_RESOURCES,
  type RoleName,
  roles,
  statements,
} from "./access"

export type Permissions = PermissionsOf<Catalog>

/**
 * One permission set per role in a member's role string ("admin,member" -> two sets), kept apart
 * because better-auth grants a request only when a single role allows all of it. Unknown roles grant
 * nothing.
 */
export function rolePermissions(role: string): PermissionSet[] {
  return role
    .split(",")
    .map((r) => r.trim())
    .filter((r): r is RoleName => r in roles)
    .map((r) => roles[r].statements as PermissionSet)
}

/**
 * Coarse OAuth scopes shown on the consent screen. A token may do what one of the user's roles allows
 * AND what its scopes allow. Defined explicitly; never derived from action names.
 */
export const OAUTH_SCOPE_GRANTS = {
  read: {
    project: ["read"],
    apiKey: ["read"],
    agent: ["read"],
    run: ["read"],
    featureFlag: ["read"],
    // The organization's plan, features, limits and usage (better-auth's /entitlements/get, which
    // only a session reaches in this app; whoami reports the same through the API).
    entitlements: ["read"],
  },
  write: {
    project: ["create", "read", "update", "delete"],
    apiKey: ["read"],
    agent: ["create", "read", "update", "delete"],
    run: ["create", "read", "update", "steer"],
    // Ramping a flag (operator organization only): an agent may target and ramp, not delete.
    featureFlag: ["read", "update"],
  },
  admin: {
    organization: ["update"],
    member: ["create", "read", "update", "delete"],
    invitation: ["create", "cancel"],
    apiKey: ["create", "read", "update", "delete"],
    featureFlag: ["read", "update", "delete"],
  },
} as const satisfies Record<string, Permissions>

export type OAuthScope = keyof typeof OAUTH_SCOPE_GRANTS
export const OAUTH_SCOPES = Object.keys(OAUTH_SCOPE_GRANTS) as OAuthScope[]

/**
 * What an impersonated session (an admin acting as the user, see guards.ts) may do through the API:
 * reads only. Narrows whatever the member's roles allow, so no key can be created while impersonating.
 */
export const IMPERSONATION_GRANTS = {
  project: ["read"],
  apiKey: ["read"],
  agent: ["read"],
  run: ["read"],
  member: ["read"],
} as const satisfies Permissions

/** Every action of the person-only resources (owner-only ones and billing), whole. */
const personOnlyResources = Object.fromEntries(
  PERSON_ONLY_RESOURCES.map((resource) => [resource, statements[resource]]),
) as Permissions

/**
 * The org brain's resources (apps/hq). No OAuth scope reaches them yet: an API key carries them,
 * and which scope an MCP client gets is decided with the brain's operations (a change to
 * OAUTH_SCOPE_GRANTS is a change to the public contract, see apps/api/openapi.json).
 */
const hqResources = {
  hq_entry: statements.hq_entry,
  hq_proposal: statements.hq_proposal,
  hq_run: statements.hq_run,
  hq_spend: statements.hq_spend,
} as Permissions

/**
 * Actions no OAuth token can ever get: an agent should not delete orgs or edit roles. The
 * person-only part (SSO, SCIM, billing, 2FA reset, approvals) is derived from the catalog, so an
 * agent never sets up SSO, mints SCIM tokens, changes the subscription, decides an approval or
 * resets 2FA. Those are for a person, in the web app.
 */
export const OAUTH_EXCLUDED: Permissions = {
  organization: ["delete"],
  ac: ["create", "read", "update", "delete"],
  team: ["create", "update", "delete"],
  ...personOnlyResources,
  ...PERSON_ONLY_ACTIONS,
  // After the person-only actions: the whole resource is out, not just its person-only action.
  ...hqResources,
}

/** What a set of granted OAuth scopes allows (unknown scopes such as `openid` allow nothing). */
export function scopePermissions(scopes: readonly string[]): PermissionSet {
  return union(
    ...scopes
      .filter((s): s is OAuthScope => s in OAUTH_SCOPE_GRANTS)
      .map((s) => OAUTH_SCOPE_GRANTS[s] as PermissionSet),
  )
}

/** Narrow each role's permissions to what a credential allows. Empty grants are dropped. */
export function narrow(grants: PermissionSet[], credential: PermissionSet): PermissionSet[] {
  return grants.map((g) => intersect(g, credential)).filter((g) => Object.keys(g).length > 0)
}
