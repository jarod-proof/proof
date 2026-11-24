import type { FakeHq } from "./fake-hq"

/**
 * The first GET whose URL starts with `prefix` answers 500, and no other request does. (A one-shot
 * `hq.state.nextError` goes to whichever request is sent first, and since Phase 4 that is the
 * pipeline's board read, not the proposals' list.)
 */
export function failOnce(hq: FakeHq, prefix: string): void {
  const real = hq.fetch
  let failed = false
  hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!failed && (init?.method ?? "GET").toUpperCase() === "GET" && url.startsWith(prefix)) {
      failed = true
      return new Response(
        JSON.stringify({ error: { code: "INTERNAL", message: "Internal error" } }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      )
    }
    return real(input, init)
  }) as typeof fetch
}
