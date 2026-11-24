export const NAV_KEYS = [
  "digest",
  "board",
  "intent",
  "approvals",
  "designs",
  "sdlc",
  "tuning",
  "readiness",
  "runner",
] as const
export type NavKey = (typeof NAV_KEYS)[number]

/** A count the sidebar can badge; Phase 4 adds merge approvals and agent questions to the same one. */
export type BadgeKey = "pendingProposals"

export interface NavItem {
  key: NavKey
  label: string
  to: "/digest" | "/approvals" | "/runner" | (string & {})
  icon: NavKey
  badgeKey?: BadgeKey
}

/** Only the screens that exist, in NAV_KEYS order. A new screen adds one entry here. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "digest", label: "Digest", to: "/digest", icon: "digest" },
  {
    key: "approvals",
    label: "Approvals",
    to: "/approvals",
    icon: "approvals",
    badgeKey: "pendingProposals",
  },
  { key: "runner", label: "Runner & policy", to: "/runner", icon: "runner" },
]
