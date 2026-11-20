// Test-only: a browser stand-in for driving auth over HTTP the way a web app does. It keeps a
// cookie jar, sends Origin like a browser, and runs the real `createClient` against the app.
import { createClient } from "@proof/auth/client"
import { BASE } from "./app.test.helpers"

type Fetch = (url: string, init?: RequestInit) => Response | Promise<Response>

export function browser(fetch: Fetch, origin = BASE) {
  const jar = new Map<string, string>()

  const store = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";")
      const eq = pair.indexOf("=")
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const expired = attrs.some((a) => {
        const [k = "", v = ""] = a.trim().split("=")
        if (k.toLowerCase() === "max-age") return Number(v) <= 0
        if (k.toLowerCase() === "expires") return new Date(v).getTime() <= Date.now()
        return false
      })
      if (expired || value === "") jar.delete(name)
      else jar.set(name, value)
    }
  }

  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")

  /** A request from this browser: its cookies and Origin, and any Set-Cookie it gets back. */
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size > 0) headers.set("cookie", cookie())
    if (!headers.has("origin")) headers.set("origin", origin)
    const url = path.startsWith("http") ? path : `${BASE}${path}`
    const res = await fetch(url, { ...init, headers, redirect: "manual" })
    store(res)
    return res
  }

  const client = createClient(BASE, {
    customFetchImpl: (input, init) =>
      request(input instanceof Request ? input.url : String(input), init),
  })

  return { client, request, cookie, jar }
}
