import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createClient, personalSlug } from "./client"

const importsOf = (file: string) =>
  [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/from "([^"]+)"/g)].map(
    (m) => m[1],
  )

describe("createClient", () => {
  it("creates a typed auth client", () => {
    const client = createClient("http://localhost:3000")
    expect(typeof client.signIn.email).toBe("function")
    expect(typeof client.organization.inviteMember).toBe("function")
  })

  it("calls the public sign-in methods endpoint without a session", async () => {
    const calls: string[] = []
    const client = createClient("http://localhost:3000", {
      customFetchImpl: async (url) => {
        calls.push(url instanceof Request ? url.url : String(url))
        return new Response(JSON.stringify({ password: true, social: ["github"] }), {
          headers: { "content-type": "application/json" },
        })
      },
    })
    const res = await client.signInMethods()
    expect(res.error).toBeNull()
    expect(res.data).toEqual({ password: true, social: ["github"] })
    expect(calls).toEqual(["http://localhost:3000/api/auth/sign-in-methods"])
  })

  it("calls the notifications endpoints with their methods", async () => {
    const calls: string[] = []
    const client = createClient("http://localhost:3000", {
      customFetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url instanceof Request ? url.url : String(url)}`)
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    })
    await client.inbox.list({ query: { filter: "unread" } })
    await client.inbox.unreadCount()
    await client.inbox.markRead({ id: "n1" })
    await client.inbox.markAllRead({})
    expect(calls).toEqual([
      "GET http://localhost:3000/api/auth/inbox/list?filter=unread",
      "GET http://localhost:3000/api/auth/inbox/unread-count",
      "POST http://localhost:3000/api/auth/inbox/mark-read",
      "POST http://localhost:3000/api/auth/inbox/mark-all-read",
    ])
  })

  // Support's widget and support queue call these through the typed client (@byo-oss/support).
  it("calls the support endpoints with their methods", async () => {
    const calls: string[] = []
    const client = createClient("http://localhost:3000", {
      customFetchImpl: async (url, init) => {
        const href = url instanceof Request ? url.url : String(url)
        calls.push(`${init?.method ?? "GET"} ${href.replace("http://localhost:3000/api/auth", "")}`)
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    })
    await client.support.myTickets({ query: { status: "open" } })
    await client.support.ticket({ query: { id: "t1" } })
    await client.support.createTicket({ subject: "Help", body: "Please" })
    await client.support.reply({ ticketId: "t1", body: "More" })
    await client.support.agent.tickets({ query: { assignee: "me" } })
    await client.support.agent.reply({ ticketId: "t1", body: "Done", internal: true })
    await client.support.agent.update({ ids: ["t1"], status: "solved" })
    await client.support.agent.tags()
    await client.support.agent.canned()
    await client.support.agent.canned.save({ title: "Hi", body: "Hello" })
    expect(calls).toEqual([
      "GET /support/my-tickets?status=open",
      "GET /support/ticket?id=t1",
      "POST /support/create-ticket",
      "POST /support/reply",
      "GET /support/agent/tickets?assignee=me",
      "POST /support/agent/reply",
      "POST /support/agent/update",
      "GET /support/agent/tags",
      "GET /support/agent/canned",
      "POST /support/agent/canned/save",
    ])
  })

  it("re-exports the personal organization slug rule", () => {
    expect(personalSlug("u1")).toBe("personal-u1")
  })

  // The client ships to browsers: no server code (@proof/api, the DB, ./permissions) may reach it.
  it("imports only browser-safe modules", () => {
    const browserSafe =
      /^(better-auth\/client(\/plugins)?|better-auth\/plugins\/(organization\/)?access|@better-auth\/oauth-provider\/client|@better-auth\/passkey\/client|@better-auth\/sso\/client|@better-auth\/stripe\/client|@wraps\.dev\/better-auth\/client|@byo-oss\/notifications\/client|@byo-oss\/support\/client|@byo-oss\/entitlements\/client|\.\/access|\.\/reserved-slugs|\.\/constants|\.\/membership|\.\/sign-in-methods-shared)$/
    const imports = [...importsOf("./client.ts"), ...importsOf("./access.ts")]
    expect(imports.filter((i) => !browserSafe.test(i ?? ""))).toEqual([])
  })
})
