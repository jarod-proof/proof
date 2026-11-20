// The permission catalog and roles, with no server code: the browser client imports this file, so
// it may only import better-auth's access modules and other browser-safe entries (support's and
// entitlements' `/client`). Grant math lives in ./permissions.
import { entitlementsStatements } from "@byo-oss/entitlements/client"
import { supportRoles, supportStatements } from "@byo-oss/support/client"
import { createAccessControl } from "better-auth/plugins/access"
import { defaultStatements } from "better-auth/plugins/organization/access"

/**
 * The permission catalog: every resource and action in the product. Roles, API keys, OAuth scopes
 * and operations are all expressed in these terms. Add your resources here.
 * The first five come from better-auth's organization plugin; `apiKey` is checked by the api-key plugin.
 */
export const statements = {
  ...defaultStatements,
  // Read lets admins list members with their security state (two-factor, last active).
  member: ["create", "read", "update", "delete"],
  apiKey: ["create", "read", "update", "delete"],
  project: ["create", "read", "update", "delete"],
  // Workspace agents (the configured workers and their settings, not connected AI clients).
  agent: ["create", "read", "update", "delete"],
  // Runs of an agent. `update` is what an agent does while it runs (steps, status, approval
  // requests); `approve` is a person's decision (never granted to a key or an OAuth token);
  // `steer` covers the messages and deferrals a person sends to a run.
  run: ["create", "read", "update", "approve", "steer"],
  // The org brain (apps/hq). Prefixed because `run` above is the product's runs. `hq_entry` is
  // the brain's facts, voice, decisions and playbooks; `hq_proposal` is a change waiting for a
  // founder; `hq_run` is a build, review or chat the factory ran; `hq_spend` is the daily model
  // spend ledger and its grants (`record` is what a key does: reserve, settle and record spend;
  // `request` is asking for a grant: hq records a pending request a founder may redeem in Slack).
  hq_entry: ["read", "update"],
  hq_proposal: ["read", "create", "decide"],
  hq_run: ["read", "create", "update"],
  hq_spend: ["read", "record", "request", "grant"],
  // Feature flag rollouts. Owners and admins hold it in every organization, but the operations
  // using it are for the operator organization only (audience "operator"), refused anywhere else.
  featureFlag: ["read", "update", "delete"],
  // Owner only (see roles): single sign-on providers and SCIM provisioning tokens (mint, list, revoke).
  sso: ["read", "update"],
  scim: ["create", "read", "delete"],
  // Owners and admins (see roles): the organization's subscription and its billing.
  subscription: ["read", "update"],
  // Owner only: turning off another member's two-factor sign-in.
  twoFactor: ["reset"],
  // Customer support (@byo-oss/support): held in the operator organization, its members are the
  // support staff. `read` the queue and any ticket, `reply` (replies and internal notes), `update`
  // (status, priority, assignee, tags, merge), `manage` canned replies, `delete` tickets. The
  // package's own list (its browser-safe `/client` entry). A person's resource: no key or OAuth token.
  ...supportStatements,
  // Plan entitlements (@byo-oss/entitlements): `read` the organization's plan, features, limits
  // and usage (every role); `override` comps a feature, raises a limit or changes the plan of any
  // organization, and is only ever checked in the operator organization (the staff organization).
  // A person's action: no key or OAuth token (PERSON_ONLY_ACTIONS).
  ...entitlementsStatements,
} as const

export type Catalog = typeof statements
export const ac = createAccessControl(statements)

const all = Object.fromEntries(
  Object.entries(statements).map(([resource, actions]) => [resource, [...actions]]),
) as { -readonly [R in keyof Catalog]: Catalog[R][number][] }

/** Resources only the owner role holds: the admin role is built without them. */
export const OWNER_ONLY_RESOURCES = ["sso", "scim", "twoFactor"] as const

/**
 * Resources a person holds but no API key or OAuth token may: the owner-only ones, billing (owner
 * and admin), and support (staff and customers use it from the web app, with a cookie session).
 */
export const PERSON_ONLY_RESOURCES = [...OWNER_ONLY_RESOURCES, "subscription", "support"] as const

/**
 * Actions a person holds but no API key or OAuth token may. Approving a run is a person's decision
 * (the approval is theirs, not an agent's); so is a staff override of another organization's plan,
 * and editing an hq entry, deciding an hq proposal or granting hq spend. Keys are refused these in create_api_key, and OAuth
 * scopes never reach them (OAUTH_EXCLUDED in permissions.ts is built from this).
 */
export const PERSON_ONLY_ACTIONS = {
  run: ["approve"],
  entitlements: ["override"],
  // The brain's trust rule: keys write proposals and run logs only. Only a signed-in founder edits
  // an entry, decides a proposal or grants spend. hq strips these from any caller that is not a
  // session (apps/hq/src/app.ts), whoever minted the key.
  hq_entry: ["update"],
  hq_proposal: ["decide"],
  hq_spend: ["grant"],
} as const

const adminStatements = Object.fromEntries(
  Object.entries(all).filter(
    ([resource]) => !(OWNER_ONLY_RESOURCES as readonly string[]).includes(resource),
  ),
) as typeof all

/**
 * Fixed capability roles: the catalog's named bundles of permissions, shipped with the product.
 * A member may hold several ("viewer,approver"), and better-auth grants a request only when one
 * role covers all of it (see rolePermissions). Organizations can't define their own yet: database
 * roles (the organization plugin's dynamicAccessControl) are on the roadmap (docs/roadmap.md).
 */
export const roles = {
  owner: ac.newRole(all),
  admin: ac.newRole({ ...adminStatements, organization: ["update"] }),
  member: ac.newRole({
    ac: ["read"],
    apiKey: ["read"],
    project: ["create", "read", "update"],
    agent: ["create", "read", "update"],
    run: ["create", "read", "update", "approve", "steer"],
    // In the operator organization: works the support queue, without canned replies or deletes.
    ...supportRoles.member,
    entitlements: ["read"],
  }),
  viewer: ac.newRole({ project: ["read"], agent: ["read"], run: ["read"], entitlements: ["read"] }),
  // A reviewer: signs off on runs. Never changes agents or starts runs.
  approver: ac.newRole({
    run: ["read", "approve"],
    project: ["read"],
    agent: ["read"],
    entitlements: ["read"],
  }),
  // Runs and steers agents, without deciding approvals or changing their configuration.
  operator: ac.newRole({
    project: ["read"],
    agent: ["read"],
    run: ["create", "read", "update", "steer"],
    entitlements: ["read"],
  }),
  // Finance: the subscription and its billing, without admin rights over members or agents.
  billing: ac.newRole({ subscription: ["read", "update"], entitlements: ["read"] }),
} as const

export type RoleName = keyof typeof roles
