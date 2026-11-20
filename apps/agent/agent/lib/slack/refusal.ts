import { refusalText } from "../spend/cap.js"
import type { SpendStore } from "../spend/hooks.js"

/**
 * Tells the thread why a turn was refused, naming what is left today and how to ask for more.
 *
 * @remarks
 * A cancelled turn has no model reply, a hook cannot add text, and the cancelled `turn.settled`
 * carries no cause naming the hook, so the spend hook leaves the refusal in session state
 * (`SpendState.refusal`) and the Slack channel posts it. Nothing is posted for any other turn, and
 * the note is cleared once posted. Posting is best effort: a failure is the caller's to log, and
 * never turns the refusal into a run.
 */
export async function postCapRefusal(
  event: { data: { outcome: string } },
  thread: { post(message: { text: string }): Promise<unknown> },
  store: SpendStore,
): Promise<boolean> {
  if (event.data.outcome !== "cancelled") {
    return false
  }
  const { refusal } = store.get()
  if (refusal === null) {
    return false
  }
  store.update((s) => ({ ...s, refusal: null }))
  await thread.post({ text: refusalText(refusal) })
  return true
}
