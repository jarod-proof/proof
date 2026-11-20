import { memberInOrg, name, UserId } from "@proof/auth-proofs"
import { AppError } from "@proof/errors"
import { z } from "zod"

import { listMemberSecurity, resetMemberTwoFactor } from "../data/members"
import { inCallerOrg, requireInOrg } from "../tenant"
import { defineOperation, notifySafely, type OperationDeps, personUserId } from "./shared"

export function memberOperations({ db, notifier }: Pick<OperationDeps, "db" | "notifier">) {
  const list_member_security = defineOperation({
    name: "list_member_security",
    method: "GET",
    path: "/v1/members/security",
    summary: "List members with their two-factor state and last activity",
    description:
      "Lists this organization's members with their role, whether two-factor sign-in is on, and when they were " +
      "last active. Last active is the person's latest session (sessions belong to people, not organizations). " +
      "For organization admins and owners. Owners can turn a member's two-factor off with reset_member_two_factor.",
    permissions: { member: ["read"] },
    input: z.object({}),
    output: z.object({
      members: z.array(
        z.object({
          userId: z.string(),
          name: z.string(),
          email: z.string(),
          role: z.string(),
          twoFactorEnabled: z.boolean(),
          lastActiveAt: z.string().nullable(),
        }),
      ),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: (_input, { caller }) =>
      inCallerOrg(caller, async (org, proof) => ({
        members: (await listMemberSecurity(db, org, proof)).map((m) => ({
          userId: m.userId,
          name: m.name,
          email: m.email,
          role: m.role,
          twoFactorEnabled: m.twoFactorEnabled,
          lastActiveAt: m.lastActiveAt ? m.lastActiveAt.toISOString() : null,
        })),
      })),
  })

  const reset_member_two_factor = defineOperation({
    name: "reset_member_two_factor",
    method: "POST",
    path: "/v1/members/:userId/two-factor/reset",
    summary: "Turn off a member's two-factor sign-in (owners only)",
    description:
      "Removes a member's authenticator and backup codes and turns their two-factor sign-in off, so they sign in " +
      "without the second factor. Only an owner can do it, and not for themselves (they use their own security " +
      "settings). Audited. Returns NOT_FOUND for users who are not members of this organization. Two-factor " +
      "belongs to the account, so it is refused with CONFLICT while the member belongs to any other organization; " +
      "the person then turns it off in their own security settings. Confirm with the user before calling.",
    permissions: { twoFactor: ["reset"] },
    fresh: true,
    input: z.object({
      userId: z.string().describe("The member's user id, from list_member_security"),
    }),
    output: z.object({ reset: z.literal(true) }),
    hints: { readOnly: false, destructive: true },
    examples: [{ input: { userId: "00000000-0000-0000-0000-000000000000" }, error: "NOT_FOUND" }],
    handler: ({ userId }, { caller }) =>
      inCallerOrg(caller, (org, proof) =>
        name(UserId(userId), async (user) => {
          if (caller.actor.type === "user" && caller.actor.userId === userId) {
            throw new AppError("BAD_REQUEST", "You can't reset your own two-factor here", {
              hint: "Turn it off in your own security settings.",
            })
          }
          const inOrg = await requireInOrg(memberInOrg, db, user, org, "Member")
          await resetMemberTwoFactor(db, user, org, { member: inOrg, actor: proof })
          await notifySafely(() =>
            notifier.inOrg(org, proof, {
              type: "security.two_factor_reset",
              memberUserId: userId,
              actorUserId: personUserId(caller),
            }),
          )
          return { reset: true as const }
        }),
      ),
  })

  return {
    list_member_security,
    reset_member_two_factor,
  }
}
