import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"

import type { BadgeKey, NavItem, NavKey } from "../lib/nav"
import { NavIcon } from "./nav-icon"

export interface SidebarProps {
  items: readonly NavItem[]
  /** The item to mark current; null on a page that is no nav item (not found). */
  activeKey: NavKey | null
  badges: Partial<Record<BadgeKey, number>>
  runner: ReactNode
  account: ReactNode
}

const BADGE_CAP = 99

function badgeText(count: number | undefined): string | null {
  if (count === undefined || count <= 0) return null
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count)
}

export function Sidebar({ items, activeKey, badges, runner, account }: SidebarProps) {
  return (
    <div className="flex min-h-full flex-col gap-5 bg-sidebar px-3 py-4.5 text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-2">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="text-primary"
        >
          <path d="M3 20h18" />
          <path d="M5 20V9l5 3V9l5 3V5h4v15" />
        </svg>
        <span className="font-mono text-sm font-medium tracking-wide text-foreground">
          software factory
        </span>
      </div>
      <nav aria-label="Primary">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {items.map((item) => {
            const active = item.key === activeKey
            const badge = badgeText(item.badgeKey ? badges[item.badgeKey] : undefined)
            return (
              <li key={item.key}>
                <Link
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-touch items-center gap-2.5 rounded-lg px-2.5 text-sm ${
                    active ? "bg-accent text-foreground" : "text-sidebar-foreground"
                  }`}
                >
                  <NavIcon name={item.icon} />
                  <span className="flex-1">{item.label}</span>
                  {badge ? (
                    <span className="rounded-md bg-solar px-1.5 py-px font-mono text-[11px] font-medium text-solar-foreground">
                      {badge}
                    </span>
                  ) : null}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="flex-1" />
      {runner}
      {account}
    </div>
  )
}
