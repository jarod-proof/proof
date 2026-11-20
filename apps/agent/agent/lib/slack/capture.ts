/**
 * The raw request behind a card click, kept from the moment eve's route verifies it until
 * `onInteraction` runs, so the same bytes can be forwarded to hq.
 *
 * @remarks
 * eve hands `onInteraction` only the parsed action, but hq must verify Slack's signature over the
 * exact body, so the webhook verifier (which does see the request) leaves a copy here. Each entry
 * belongs to ONE click: it is keyed by that click's Slack `trigger_id`, which is unique per click,
 * so two clicks in flight can never take each other's body or signature. On the way out the entry
 * is checked against the action eve parsed (same Slack user, same action id), used once, and
 * dropped. Entries expire and the store is bounded, because eve drops a Slack timeout retry after
 * verification and its entry would never be taken.
 */

/** One verified click's bytes, as Slack sent them. */
export interface CapturedClick {
  rawBody: string
  signature: string
  timestamp: string
}

interface Entry extends CapturedClick {
  userId: string
  actionIds: string[]
  expiresAt: number
}

/** The part of eve's parsed action the capture is matched against. */
export interface ClickIdentity {
  triggerId?: string
  actionId: string
  user: { id: string }
}

/** Our buttons' action ids start with this; nothing else is kept. */
export const CARD_ACTION_PREFIX = "hq_"

export const CAPTURE_TTL_MS = 2 * 60 * 1000
export const CAPTURE_MAX_ENTRIES = 256

/** What hq's buttons look like inside a signed form body, or null for any other request. */
function readCardClick(
  rawBody: string,
): { triggerId: string; userId: string; actionIds: string[] } | null {
  const text = new URLSearchParams(rawBody).get("payload")
  if (text === null) return null
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as {
    type?: unknown
    trigger_id?: unknown
    user?: { id?: unknown }
    actions?: unknown
  }
  if (p.type !== "block_actions" || !Array.isArray(p.actions)) return null
  if (typeof p.trigger_id !== "string" || typeof p.user?.id !== "string") return null
  const actionIds = p.actions
    .map((a) => (a as { action_id?: unknown }).action_id)
    .filter((id): id is string => typeof id === "string" && id.startsWith(CARD_ACTION_PREFIX))
  return actionIds.length === 0 ? null : { triggerId: p.trigger_id, userId: p.user.id, actionIds }
}

export function createClickCapture(
  options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
) {
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? CAPTURE_TTL_MS
  const max = options.maxEntries ?? CAPTURE_MAX_ENTRIES
  const entries = new Map<string, Entry>()

  const sweep = () => {
    const at = now()
    for (const [key, entry] of entries) if (entry.expiresAt <= at) entries.delete(key)
    // Over the bound: the oldest go first (a Map keeps insertion order).
    for (const key of entries.keys()) {
      if (entries.size <= max) break
      entries.delete(key)
    }
  }

  return {
    /** Keep a verified request's bytes if it is a click on one of hq's buttons. */
    keep(request: CapturedClick): void {
      const click = readCardClick(request.rawBody)
      if (!click) return
      sweep()
      entries.set(click.triggerId, {
        ...request,
        userId: click.userId,
        actionIds: click.actionIds,
        expiresAt: now() + ttl,
      })
      sweep()
    },
    /**
     * The bytes for the click eve parsed, or null: no entry (expired, never kept, already taken)
     * or one that is not this click's (another user or another action). Taken once.
     */
    take(action: ClickIdentity): CapturedClick | null {
      sweep()
      if (!action.triggerId) return null
      const entry = entries.get(action.triggerId)
      if (!entry) return null
      entries.delete(action.triggerId)
      if (entry.userId !== action.user.id || !entry.actionIds.includes(action.actionId)) {
        return null
      }
      return { rawBody: entry.rawBody, signature: entry.signature, timestamp: entry.timestamp }
    },
    /** How many clicks are waiting to be taken. */
    get size(): number {
      sweep()
      return entries.size
    },
  }
}

export type ClickCapture = ReturnType<typeof createClickCapture>

/** The agent's capture: what the Slack channel's verifier keeps and its `onInteraction` takes. */
export const clickCapture: ClickCapture = createClickCapture()
