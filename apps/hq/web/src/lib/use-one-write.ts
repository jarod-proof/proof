import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { HqError } from "../api/errors"
import { hqKeys } from "../api/query-keys"
import { errorMessage } from "../components/states"

/** hq's words for a refused write that the board always meets: a pull request that moved on. */
const CHANGED = "The pull request changed since you looked"
/** What a write answers when another one is still on its way (nothing was sent). */
export const BUSY_MESSAGE = "Another change is in flight. Try again when it has finished."

/**
 * What a refused write says. A 409, a 403 and a 400 keep hq's own message (hq is the one deciding
 * and its message is its own words, not a label of ours); hq's hint, which `HqError` drops, is
 * restored for the one refusal the board always meets: a pull request that moved on. Every other
 * kind reads through the one error table.
 */
export function writeMessage(error: unknown): string {
  if (error instanceof HqError) {
    if (error.kind === "conflict" && error.message.startsWith(CHANGED)) {
      return `${CHANGED}. Review it again.`
    }
    if (error.kind === "conflict" || error.kind === "forbidden" || error.kind === "bad-request") {
      return error.message
    }
  }
  return errorMessage(error)
}

/** What a screen reads of its writes. */
export interface OneWrite {
  /** The key of the write on its way, or null. While it is not null nothing else is sent. */
  pending: string | null
  /** hq's answer to each refused write, by key; cleared when that key is sent again. */
  errors: Record<string, string>
  /** The line the last successful write returned; cleared when the next one starts. */
  notice: string | null
  /**
   * One write: `send` returns the line to show when it worked. Never retried, never concurrent:
   * resolves `true` when it was run (whatever hq answered), `false` when another write was still
   * in flight, in which case nothing was sent and `errors[key]` says so (`BUSY_MESSAGE`).
   */
  write(key: string, send: () => Promise<string>): Promise<boolean>
}

/**
 * The one-write lock every founder write of the app goes through. A synchronous lock (a ref, set
 * before the first await) closes the gap a re-render leaves open, so two clicks in one tick send
 * one request. The lock is held until `invalidate` has been read again (the screen is then the
 * truth: a decided card has left), and released on success, on error and when the re-read fails.
 * A 409 re-reads too; a 401 invalidates the gate's status probe so the app lands on sign-in.
 * There is no timeout here: a request that never settles holds the lock until reload.
 */
export function useOneWrite({
  queryClient,
  invalidate = [hqKeys.work(), hqKeys.factoryStatus()],
}: {
  queryClient: QueryClient
  /** The query keys (prefixes) to read again after a write. */
  invalidate?: readonly QueryKey[]
}): OneWrite {
  const [pending, setPending] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const sending = useRef(false)

  const refresh = () =>
    Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })))

  const write: OneWrite["write"] = async (key, send) => {
    if (sending.current) {
      setErrors((current) => ({ ...current, [key]: BUSY_MESSAGE }))
      return false
    }
    sending.current = true
    setPending(key)
    setNotice(null)
    setErrors(({ [key]: _cleared, ...rest }) => rest)
    try {
      const message = await send()
      // The card leaves only when the screen says so; until then it stays disabled.
      await refresh()
      setNotice(message)
    } catch (error) {
      setErrors((current) => ({ ...current, [key]: writeMessage(error) }))
      if (error instanceof HqError && error.kind === "conflict") await refresh()
      if (error instanceof HqError && error.kind === "unauthorized") {
        await queryClient.invalidateQueries({ queryKey: hqKeys.status() })
      }
    } finally {
      sending.current = false
      setPending(null)
    }
    return true
  }

  return { pending, errors, notice, write }
}
