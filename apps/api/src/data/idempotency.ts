// Idempotency-Key records. Reserve before the handler runs and complete after, so two concurrent
// retries can't both run it. A reservation holds for LEASE_MS and a completed key for 24 hours; an
// expired key is reclaimed by the next reserve.
//
// Nothing in a row is readable from the database alone. The client's key is stored as an HMAC under
// the server secret, and the response (which can hold a new API key) is sealed with AES-256-GCM
// under a key derived from the server secret, the organization and the client's raw key. Replaying
// needs the request that carries that key, so a dump of the table yields no secrets.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto"
import type { CallerActsFor, Named, OrganizationId } from "@proof/auth-proofs"
import { type Database, idempotencyKey } from "@proof/db"
import { and, eq, lt } from "drizzle-orm"

const TTL_MS = 24 * 60 * 60 * 1000
/**
 * How long a reservation holds before a retry may claim it. Completing the key extends it to TTL_MS.
 * If the completion write fails after the handler ran, retries get CONFLICT for this long and then
 * run the operation again, instead of being refused for a day. Handlers must finish well inside it.
 */
export const LEASE_MS = 5 * 60 * 1000

/** The server secret, the organization and the client's key, which together name one record. */
export interface IdempotencyRef {
  secret: string
  key: string
}

const derive = (secret: string, purpose: string, org: string, key: string) =>
  Buffer.from(hkdfSync("sha256", secret, "proof-idempotency", `${purpose}\0${org}\0${key}`, 32))

/** The stored form of a client's Idempotency-Key. */
export function idempotencyLookup(secret: string, org: string, key: string): string {
  return createHmac("sha256", derive(secret, "lookup", org, ""))
    .update(key)
    .digest("base64url")
}

interface Sealed {
  v: 1
  iv: string
  tag: string
  data: string
}

function seal(value: unknown, secret: string, org: string, key: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", derive(secret, "seal", org, key), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value) ?? "null"), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    data: data.toString("base64url"),
  }
}

function unseal(sealed: Sealed, secret: string, org: string, key: string): unknown {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    derive(secret, "seal", org, key),
    Buffer.from(sealed.iv, "base64url"),
  )
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"))
  const text = Buffer.concat([
    decipher.update(Buffer.from(sealed.data, "base64url")),
    decipher.final(),
  ]).toString("utf8")
  return JSON.parse(text)
}

export type ReserveResult =
  /** Reserved: run the operation, then complete or release the key. */
  | { state: "new" }
  /** A finished call with this key and request: replay its stored response. */
  | { state: "done"; response: unknown }
  /** Another call with this key is still running (or the reservation is being written). */
  | { state: "in_progress" }
  /** The key was used for a different operation or request body. */
  | { state: "mismatch" }

export async function reserveIdempotencyKey<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  input: IdempotencyRef & { operation: string; requestHash: string },
): Promise<ReserveResult> {
  const now = new Date()
  const lookup = idempotencyLookup(input.secret, org.value, input.key)
  const fresh = {
    operation: input.operation,
    requestHash: input.requestHash,
    status: "in_progress",
    response: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + LEASE_MS),
  }
  // One statement claims the key when it is new, or when its record has expired.
  const claimed = await db
    .insert(idempotencyKey)
    .values({ id: crypto.randomUUID(), organizationId: org.value, key: lookup, ...fresh })
    .onConflictDoUpdate({
      target: [idempotencyKey.organizationId, idempotencyKey.key],
      set: fresh,
      setWhere: lt(idempotencyKey.expiresAt, now),
    })
    .returning({ id: idempotencyKey.id })
  if (claimed.length > 0) return { state: "new" }

  const [row] = await db
    .select()
    .from(idempotencyKey)
    .where(and(eq(idempotencyKey.organizationId, org.value), eq(idempotencyKey.key, lookup)))
    .limit(1)
  if (!row) return { state: "in_progress" }
  if (row.operation !== input.operation || row.requestHash !== input.requestHash) {
    return { state: "mismatch" }
  }
  if (row.status === "done") {
    const response = unseal(row.response as Sealed, input.secret, org.value, input.key)
    return { state: "done", response }
  }
  return { state: "in_progress" }
}

export async function completeIdempotencyKey<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  input: IdempotencyRef & { response: unknown },
): Promise<void> {
  const lookup = idempotencyLookup(input.secret, org.value, input.key)
  await db
    .update(idempotencyKey)
    .set({
      status: "done",
      response: seal(input.response, input.secret, org.value, input.key),
      expiresAt: new Date(Date.now() + TTL_MS),
    })
    .where(and(eq(idempotencyKey.organizationId, org.value), eq(idempotencyKey.key, lookup)))
}

/** Drop a reservation whose handler failed, so a retry can run. Completed keys are kept. */
export async function releaseIdempotencyKey<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  ref: IdempotencyRef,
): Promise<void> {
  await db
    .delete(idempotencyKey)
    .where(
      and(
        eq(idempotencyKey.organizationId, org.value),
        eq(idempotencyKey.key, idempotencyLookup(ref.secret, org.value, ref.key)),
        eq(idempotencyKey.status, "in_progress"),
      ),
    )
}
