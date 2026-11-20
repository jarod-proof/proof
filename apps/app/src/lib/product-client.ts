import { createClient, type operations, ProofError } from "@proof/sdk"

import { organizationHeaders } from "./org-header"
import { recordServerDate } from "./server-clock"
import { WebError } from "./web-auth"

// The browser's client for the product API (/v1), generated from the same contract the API serves.
// Requests go to the page's origin, so the session cookie goes with them. One place turns the SDK's
// ProofError into the WebError the screens show, with the server's hint appended.

/** The 200 body of an operation, as the contract types it. */
export type ResponseBody<Op extends keyof operations> =
  operations[Op]["responses"][200]["content"]["application/json"]

/** The JSON body an operation takes. */
export type RequestBody<Op extends keyof operations> = NonNullable<
  operations[Op]["requestBody"]
>["content"]["application/json"]

/** The query parameters an operation takes. */
export type QueryParams<Op extends keyof operations> = NonNullable<
  operations[Op]["parameters"]["query"]
>

export type ProductClient = ReturnType<typeof productClient>

/**
 * The product client for the page. `organizationId` is sent as X-Organization-Id, so the server can
 * refuse a call made for another org; without it the session's active organization answers.
 * Retries are off: a screen shows the failure at once rather than sleeping through a Retry-After.
 */
export function productClient(organizationId: string | undefined, fetchImpl?: typeof fetch) {
  const send = fetchImpl ?? ((input: Request) => fetch(input))
  return createClient({
    baseURL: typeof window === "undefined" ? "" : window.location.origin,
    retry: false,
    fetch: async (request) => {
      const headers = new Headers(request.headers)
      if (!headers.has("accept")) headers.set("accept", "application/json")
      if (organizationId !== undefined) {
        for (const [name, value] of Object.entries(organizationHeaders(organizationId))) {
          headers.set(name, value)
        }
      }
      const received = Date.now()
      const response = await send(new Request(request, { headers, credentials: "same-origin" }))
      recordServerDate(response.headers.get("date"), received)
      return response
    },
  })
}

/**
 * The WebError for a failed product call: the server's message and hint, joined. A failure with no
 * API body (a gateway page, a transport error without a server reply) keeps the generic text.
 */
export function toWebError(caught: unknown): unknown {
  if (!(caught instanceof ProofError)) return caught
  const message = caught.code.startsWith("HTTP_") ? undefined : caught.message
  const text = [message, caught.hint].filter(Boolean).join(" ")
  return new WebError(text || "Something went wrong", caught.status, caught.code)
}

/**
 * Awaits one typed client call and returns its 200 body. A refusal or transport failure is thrown
 * as the WebError every screen shows.
 */
export async function payload<R extends { data?: unknown }>(
  call: Promise<R>,
): Promise<NonNullable<R["data"]>> {
  let result: R
  try {
    result = await call
  } catch (caught) {
    throw toWebError(caught)
  }
  if (result.data === undefined) throw new WebError("Something went wrong", 0)
  return result.data as NonNullable<R["data"]>
}
