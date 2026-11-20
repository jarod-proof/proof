// What a password reset ends. Sessions already end (revokeSessionsOnPasswordReset); this ends the
// credentials an account holds besides its password, so someone who got to an address first (a
// squatter on an unverified sign-up) cannot keep what they planted.
import { revokeGrantsWith } from "./member-grants"
import type { Adapter } from "./membership"

/**
 * End the user's OAuth grants in every organization they belong to and, when `keys` is set,
 * disable every API key of the organizations they own. Disabled, not deleted, so a call with the
 * key says it is disabled. A key made after the reset is untouched: only what exists now is ended.
 * Runs on the better-auth adapter, as the reset hook does (no Drizzle handle inside its flow).
 */
export async function endCredentialsOnReset(
  db: Adapter,
  userId: string,
  options: { keys: boolean },
): Promise<void> {
  const memberships = await db.findMany<{ organizationId: string; role: string }>({
    model: "member",
    where: [{ field: "userId", value: userId }],
  })
  const now = new Date()
  for (const { organizationId } of memberships) {
    await revokeGrantsWith(db, { organizationId, userId }, now)
  }
  if (!options.keys) return
  const owned = memberships
    .filter((m) => m.role.split(",").some((r) => r.trim() === "owner"))
    .map((m) => m.organizationId)
  if (owned.length === 0) return
  const keys = await db.findMany<{ id: string }>({
    model: "apikey",
    where: [
      { field: "referenceId", value: owned, operator: "in" },
      { field: "enabled", value: true },
    ],
  })
  if (keys.length === 0) return
  await db.updateMany({
    model: "apikey",
    where: [{ field: "id", value: keys.map((k) => k.id), operator: "in" }],
    update: { enabled: false },
  })
}
