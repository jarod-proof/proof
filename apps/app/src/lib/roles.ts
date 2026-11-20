import type { OrgRole as OrgRoleLabel } from "@proof/ui/dplus/shell/org-picker"
import { roles } from "@proof/auth/client"

/**
 * The one place that reads a stored role string. The server keeps a member's roles as a
 * comma-separated string ("admin,member"); everything in the web app that asks about a role goes
 * through these helpers.
 */

/** A stored role string as its parts: trimmed, without empty entries. */
export function roleParts(role: string): string[] {
  return role
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** Whether a stored role string includes `name` ("owner", "admin", ...). */
export function hasRole(role: string, name: string): boolean {
  return roleParts(role).includes(name)
}

/** Whether a stored role string includes the owner role. Owners are fixed in the permission table. */
export function isOwner(role: string): boolean {
  return hasRole(role, "owner")
}

/** A role in the catalog (packages/auth/src/access.ts): one name, never a stored list. */
export type OrgRole = keyof typeof roles

/** Whether `role` is one catalog role, so it can be sent where better-auth takes a role name. */
export function isOrgRole(role: string): role is OrgRole {
  return Object.hasOwn(roles, role)
}

/** The name a person sees for each catalog role. */
export const ROLE_LABEL: Record<OrgRole, OrgRoleLabel> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
  approver: "Approver",
  operator: "Operator",
  billing: "Billing",
}

/** What a role is for, in one line (the role picker's help text). */
export const ROLE_DESCRIPTION: Record<OrgRole, string> = {
  owner: "Everything, including SSO, SCIM and billing. Can't be changed from the member list.",
  admin: "Manages members, agents, API keys and billing.",
  member: "Creates and runs agents, and approves their actions.",
  viewer: "Sees agents, runs and projects. Changes nothing.",
  approver:
    "Reviews runs and approves or denies their actions. Doesn't start runs or change agents.",
  operator: "Starts runs and steers agents. Can't approve actions or change agents.",
  billing: "Sees and changes the subscription. No access to agents, runs or members.",
}
