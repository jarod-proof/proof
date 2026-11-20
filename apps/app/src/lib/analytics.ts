import { ANALYTICS_EVENTS_PATH, type ClientEvent, MAX_CLIENT_EVENTS } from "@proof/analytics/events"
import { useRouter, useRouterState } from "@tanstack/react-router"
import { useEffect, useRef } from "react"

/**
 * The web app's analytics: page views, queued and sent to the API in batches (POST /api/events),
 * which forwards them to whatever provider it is set up with. No vendor script runs in the page, so
 * the CSP stays same-origin and swapping providers is a server change. See docs/analytics.md.
 */
export interface WebAnalytics {
  /** A page view, by route template (`/$org/runs/$runId`), never the address with its ids. */
  pageViewed(route: string): void
  /** Send what is queued now (the tab is being hidden or closed). */
  flush(): void
}

/** Sends one batch. Never throws: a lost page view is not worth an error. */
export type SendEvents = (events: ClientEvent[]) => void

/** Same origin, with the session cookie, and `keepalive` so a batch sent as the tab closes still goes. */
export const sendToApi: SendEvents = (events) => {
  void fetch(ANALYTICS_EVENTS_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => {})
}

export function createWebAnalytics({
  send,
  flushAfterMs = 5000,
}: {
  send: SendEvents
  /** How long an event waits for others to join its batch. */
  flushAfterMs?: number
}): WebAnalytics {
  let queue: ClientEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush() {
    clearTimeout(timer)
    timer = undefined
    while (queue.length > 0) send(queue.splice(0, MAX_CLIENT_EVENTS))
  }

  return {
    pageViewed(route) {
      queue.push({ name: "page.viewed", properties: { route } })
      if (queue.length >= MAX_CLIENT_EVENTS) flush()
      else timer ??= setTimeout(flush, flushAfterMs)
    },
    flush,
  }
}

// Unit tests render routes without a server: nothing is sent there.
const webAnalytics = createWebAnalytics({
  send: import.meta.env.MODE === "test" ? () => {} : sendToApi,
})

/**
 * Records a page view each time navigation settles on a new path, and sends the queue when the tab
 * is hidden. Search changes (filters, tabs in the query) are the same page.
 */
export function usePageViews(analytics: WebAnalytics = webAnalytics) {
  const router = useRouter()
  // Each navigation passes through pending (no pathname); a search change returns to the same path.
  const recorded = useRef<string | undefined>(undefined)
  const pathname = useRouterState({
    select: (s) => (s.status === "idle" ? s.resolvedLocation?.pathname : undefined),
  })

  useEffect(() => {
    if (pathname === undefined || pathname === recorded.current) return
    recorded.current = pathname
    const route = router.state.matches.at(-1)?.fullPath
    if (route) analytics.pageViewed(route)
  }, [pathname, router, analytics])

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") analytics.flush()
    }
    document.addEventListener("visibilitychange", onHide)
    return () => document.removeEventListener("visibilitychange", onHide)
  }, [analytics])
}
