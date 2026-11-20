// What our third parties say about themselves. `/health` only says this process is up; it never pings
// a dependency. This asks each vendor's own status page instead, caches the answer, and reports it,
// so an outage upstream is visible without our servers probing anything.
import type { Logger } from "@proof/logger"

/** A vendor status source. */
export type StatusProvider =
  /** An Atlassian Statuspage (most vendors): `${url}/api/v2/status.json`. */
  | { kind: "statuspage"; name: string; url: string }
  /** A status.io page (Neon, among others), by its page id. */
  | { kind: "statusio"; name: string; pageId: string }
  /**
   * AWS Health's public feed: every open event, or only those in one region, or one service in one
   * region (e.g. ses, us-east-1).
   */
  | { kind: "aws"; name: string; service?: string; region?: string }

export type ProviderState = "operational" | "degraded" | "outage" | "unknown"

export interface ProviderStatus {
  name: string
  status: ProviderState
  /** The vendor's own words, when it gave any. */
  description?: string
  /** Where a person can read more. */
  url: string
}

export interface StatusReport {
  /** The worst provider state, or "operational" with no providers. */
  status: ProviderState
  checkedAt: string
  providers: ProviderStatus[]
}

export const AWS_HEALTH_URL = "https://health.aws.amazon.com/public/currentevents"
const AWS_STATUS_PAGE = "https://health.aws.amazon.com/health/status"
export const statusioUrl = (pageId: string) => `https://api.status.io/1.0/status/${pageId}`

/**
 * Parse a provider list, comma-separated:
 * - `Name=https://status.example.com`: an Atlassian Statuspage (Vercel, Cloudflare, PlanetScale...)
 * - `Name=statusio:<page id>`: a status.io page (Neon)
 * - `aws` (every AWS event), `aws@<region>` or `aws:<service>@<region>`: AWS Health
 *
 * Throws on an entry it can't read, so a typo fails at startup rather than showing nothing.
 */
export function parseStatusProviders(spec: string | undefined): StatusProvider[] {
  if (!spec?.trim()) return []
  return spec.split(",").map((raw): StatusProvider => {
    const entry = raw.trim()
    const aws = /^aws(?::([a-z0-9-]+))?(?:@([a-z0-9-]+))?$/.exec(entry)
    // A service without a region would match nothing in the feed, which names `<service>-<region>`.
    if (aws && !(aws[1] && !aws[2])) {
      const [, service, region] = aws
      const label = ["AWS", service?.toUpperCase()].filter(Boolean).join(" ")
      return {
        kind: "aws",
        name: region ? `${label} (${region})` : label,
        ...(service && { service }),
        ...(region && { region }),
      }
    }
    const at = entry.indexOf("=")
    const name = entry.slice(0, at).trim()
    const target = entry
      .slice(at + 1)
      .trim()
      .replace(/\/+$/, "")
    const statusio = /^statusio:([0-9a-f]{24})$/.exec(target)
    if (at > 0 && name && statusio?.[1]) return { kind: "statusio", name, pageId: statusio[1] }
    if (at > 0 && name && /^https:\/\/[^\s/]+/.test(target)) {
      return { kind: "statuspage", name, url: target }
    }
    throw new Error(
      `Can't read status provider "${entry}": use Name=https://status.example.com, ` +
        "Name=statusio:<page id>, aws, aws@us-east-1 or aws:ses@us-east-1",
    )
  })
}

const SEVERITY: Record<ProviderState, number> = {
  operational: 0,
  unknown: 1,
  degraded: 2,
  outage: 3,
}

function fromIndicator(indicator: unknown): ProviderState {
  switch (indicator) {
    case "none":
      return "operational"
    case "minor":
    case "maintenance":
      return "degraded"
    case "major":
    case "critical":
      return "outage"
    default:
      return "unknown"
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

async function checkStatuspage(
  p: Extract<StatusProvider, { kind: "statuspage" }>,
  fetchFn: Fetch,
  signal: AbortSignal,
): Promise<ProviderStatus> {
  const res = await fetchFn(`${p.url}/api/v2/status.json`, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { status?: { indicator?: unknown; description?: unknown } }
  const description = body.status?.description
  return {
    name: p.name,
    status: fromIndicator(body.status?.indicator),
    ...(typeof description === "string" && { description }),
    url: p.url,
  }
}

/** status.io's overall code: 100 operational, 200 maintenance, 300-400 degraded, 500-600 down. */
function fromStatusioCode(code: unknown): ProviderState {
  if (code === 100) return "operational"
  if (code === 200 || code === 300 || code === 400) return "degraded"
  if (code === 500 || code === 600) return "outage"
  return "unknown"
}

async function checkStatusio(
  p: Extract<StatusProvider, { kind: "statusio" }>,
  fetchFn: Fetch,
  signal: AbortSignal,
): Promise<ProviderStatus> {
  const res = await fetchFn(statusioUrl(p.pageId), { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as {
    result?: { status_overall?: { status?: unknown; status_code?: unknown } }
  }
  const overall = body.result?.status_overall
  return {
    name: p.name,
    status: fromStatusioCode(overall?.status_code),
    ...(typeof overall?.status === "string" && { description: overall.status }),
    url: `https://status.io/pages/${p.pageId}`,
  }
}

interface AwsEvent {
  service?: unknown
  summary?: unknown
  impacted_services?: unknown
}

/** Text by its byte-order mark: UTF-16 big- or little-endian, else UTF-8. */
function decodeByBom(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Swapped to little-endian, which every TextDecoder supports (utf-16be needs full ICU).
    const swapped = new Uint8Array(bytes.length - (bytes.length % 2))
    for (let i = 0; i < swapped.length; i += 2) {
      swapped[i] = bytes[i + 1] as number
      swapped[i + 1] = bytes[i] as number
    }
    return new TextDecoder("utf-16le").decode(swapped)
  }
  const utf16le = bytes[0] === 0xff && bytes[1] === 0xfe
  return new TextDecoder(utf16le ? "utf-16le" : "utf-8").decode(bytes)
}

/**
 * AWS Health's feed: a list of current events, each naming `<service>-<region>`. It is UTF-16 with a
 * byte-order mark (big-endian when checked), so it is decoded by that mark, not assumed.
 */
async function awsEvents(fetchFn: Fetch, signal: AbortSignal): Promise<AwsEvent[]> {
  const res = await fetchFn(AWS_HEALTH_URL, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = decodeByBom(new Uint8Array(await res.arrayBuffer())).replace(/^\ufeff/, "")
  const events: unknown = JSON.parse(text)
  return Array.isArray(events) ? (events as AwsEvent[]) : []
}

function awsStatus(
  p: Extract<StatusProvider, { kind: "aws" }>,
  events: readonly AwsEvent[],
): ProviderStatus {
  // Feed ids are `<service>-<region>`. `impacted_services` arrives as a string of quoted ids.
  const ids = (e: AwsEvent): string[] => [
    ...(typeof e.service === "string" ? [e.service] : []),
    ...(typeof e.impacted_services === "string"
      ? [...e.impacted_services.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1] as string)
      : []),
  ]
  const matches = (id: string) =>
    p.service && p.region
      ? id === `${p.service}-${p.region}`
      : p.region
        ? id.endsWith(`-${p.region}`)
        : true
  const hits = events.filter((e) => ids(e).some(matches))
  // Each open event, with where it is: "Region Availability (multipleservices-me-central-1)".
  const description = hits
    .map((e) => [e.summary, e.service].filter((x) => typeof x === "string"))
    .filter((parts) => parts.length > 0)
    .map(([summary, where]) => (where ? `${summary} (${where})` : summary))
    .join("; ")
  return {
    name: p.name,
    // The feed only lists open events; a regional one doesn't make all of AWS an outage.
    status: hits.length > 0 ? "degraded" : "operational",
    ...(description && { description }),
    url: AWS_STATUS_PAGE,
  }
}

export interface StatusOptions {
  /** How long a report is reused. Default 60s, so traffic to /status never reaches the vendors. */
  cacheMs?: number
  /** Per-vendor budget before it counts as unknown. Default 3000. */
  timeoutMs?: number
  fetch?: Fetch
  logger?: Logger
  now?: () => number
}

/**
 * `GET /status`: each provider's state as its vendor reports it. Always 200 (this page being up is
 * not in question), with a vendor that can't be reached reported as "unknown".
 */
export function createStatusHandler(
  providers: readonly StatusProvider[],
  {
    cacheMs = 60_000,
    timeoutMs = 3000,
    fetch: fetchFn = fetch,
    logger,
    now = Date.now,
  }: StatusOptions = {},
) {
  let cached: { at: number; report: Promise<StatusReport> } | undefined

  async function build(): Promise<StatusReport> {
    const signal = AbortSignal.timeout(timeoutMs)
    let aws: Promise<AwsEvent[]> | undefined
    const results = await Promise.all(
      providers.map(async (p): Promise<ProviderStatus> => {
        try {
          if (p.kind === "statuspage") return await checkStatuspage(p, fetchFn, signal)
          if (p.kind === "statusio") return await checkStatusio(p, fetchFn, signal)
          aws ??= awsEvents(fetchFn, signal)
          return awsStatus(p, await aws)
        } catch (e) {
          logger?.warn({ err: e, provider: p.name }, "status provider unreachable")
          const url =
            p.kind === "statuspage"
              ? p.url
              : p.kind === "statusio"
                ? `https://status.io/pages/${p.pageId}`
                : AWS_STATUS_PAGE
          return { name: p.name, status: "unknown", url }
        }
      }),
    )
    const worst = results.reduce<ProviderState>(
      (acc, r) => (SEVERITY[r.status] > SEVERITY[acc] ? r.status : acc),
      "operational",
    )
    return { status: worst, checkedAt: new Date(now()).toISOString(), providers: results }
  }

  return async (): Promise<Response> => {
    if (!cached || now() - cached.at >= cacheMs) cached = { at: now(), report: build() }
    return Response.json(await cached.report, {
      headers: { "cache-control": `public, max-age=${Math.floor(cacheMs / 1000)}` },
    })
  }
}
