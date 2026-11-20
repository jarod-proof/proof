import { paginated, paginationInput } from "@proof/api"
import { AppError } from "@proof/errors"
import { z } from "zod"

import { listNotifications } from "../data/notifications"
import { inCallerOrg } from "../tenant"
import { cut, defineOperation, type OperationDeps, readCursor } from "./shared"

const notificationOutput = z.object({
  id: z.string(),
  type: z.string().describe("The event, e.g. approval.requested or member.joined"),
  title: z.string(),
  body: z.string().nullable(),
  href: z.string().nullable().describe("A path in the web app the notification links to"),
  read: z.boolean().describe("Whether the person has read it in the web app"),
  createdAt: z.string(),
})

export function notificationOperations({ db }: Pick<OperationDeps, "db">) {
  const list_notifications = defineOperation({
    name: "list_notifications",
    method: "GET",
    path: "/v1/notifications",
    summary: "List the person's notifications in this organization",
    description:
      "Lists the in-app notifications of the person this credential acts for, newest first: " +
      "approvals waiting, runs that finished or failed, members joining, usage limits and the like. " +
      "Only notifications about this organization are included; the person's account notices and " +
      "other organizations' notifications are not. Listing never marks anything read or seen, so " +
      "the person still gets their emails. Pass nextCursor back as cursor for older ones; it is " +
      "null on the last page. Needs a person: a session or an OAuth token. API keys are refused.",
    permissions: {},
    input: paginationInput,
    output: paginated("notifications", notificationOutput),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: (input, { caller }) => {
      // Org API keys have no person. Check the actor, not the session: OAuth tokens are welcome.
      if (caller.actor.type !== "user") {
        throw new AppError("FORBIDDEN", "Only a person can list notifications", {
          hint: "Sign in, or connect an OAuth client as that person. API keys have no person.",
        })
      }
      const userId = caller.actor.userId
      return inCallerOrg(caller, async (org, proof) => {
        const rows = await listNotifications(db, org, proof, {
          userId,
          after: readCursor(input.cursor),
          limit: input.limit + 1,
        })
        const { page, nextCursor } = cut(rows, input.limit, (n) => n.createdAt)
        return {
          notifications: page.map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            href: n.href,
            read: n.read,
            createdAt: n.createdAt.toISOString(),
          })),
          nextCursor,
        }
      })
    },
  })

  return {
    list_notifications,
  }
}
