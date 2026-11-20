// The API's way to send notifications (see packages/auth/src/notifications.ts for the catalog and the
// sender). An org event takes the organization as an `OrganizationId` proof plus `CallerActsFor` (what
// `inCallerOrg` hands its callback), so an operation can only notify the organization it acts in:
//   inCallerOrg(caller, (org, proof) => notifier.inOrg(org, proof, event))
// A send never fails its operation: every failure goes to `onError`, which defaults to reportError
// (it reports only 5xx and unexposed errors, see @proof/errors).
import {
  type Auth,
  createNotifier,
  type NotificationEvent,
  type NotificationType,
  type Notifier,
  type OrgEventInput,
} from "@proof/auth"
import type { CallerActsFor, Named, OrganizationId } from "@proof/auth-proofs"
import type { Database } from "@proof/db"
import { reportError } from "@proof/errors"

import { organizationRef } from "./data/organizations"

/** The events about one person, with no organization (account security, removal from an org). */
export type PersonalEventInput = Exclude<NotificationEvent, { org: { id: string } }>

export interface ApiNotifier {
  /** An event about `org`, which the caller acts in (the proofs say so; see inCallerOrg). */
  inOrg<O>(
    org: Named<O, OrganizationId>,
    _proof: CallerActsFor<O>,
    event: OrgEventInput,
  ): Promise<void>
  /** An event about one person. */
  personal(event: PersonalEventInput): Promise<void>
}

export interface ApiNotifierDeps {
  auth: Auth
  db: Database
  /** Replaces the default reporter (tests). Every failure goes here, including the org lookup. */
  onError?: (error: unknown, type: NotificationType) => void
}

const defaultReport = (error: unknown, type: NotificationType) => {
  reportError(error, { notification: type })
}

/** A notifier for one request's operations: sends through `auth.api.notify`, reports to `onError`. */
export function createApiNotifier({ auth, db, onError }: ApiNotifierDeps): ApiNotifier {
  const report = onError ?? defaultReport
  const notifier: Notifier = createNotifier({
    notify: (options) => auth.api.notify(options),
    onError: (error, event) => report(error, event.type),
  })

  return {
    async inOrg(org, _proof, event) {
      try {
        // The org's slug and name make the link and copy; a vanished org has no one to tell.
        const ref = await organizationRef(db, org.value)
        if (!ref) return
        await notifier.send({ ...event, org: ref })
      } catch (error) {
        report(error, event.type)
      }
    },
    personal(event) {
      return notifier.send(event)
    },
  }
}
