// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { NavIcon } from "../components/nav-icon"
import { NAV_ITEMS, NAV_KEYS } from "./nav"

describe("nav", () => {
  it("NAV_ITEMS holds Digest, Approvals, Runner & policy in NAV_KEYS order, with unique keys and paths", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(["Digest", "Approvals", "Runner & policy"])
    expect(NAV_ITEMS.map((item) => item.to)).toEqual(["/digest", "/approvals", "/runner"])
    const order = NAV_ITEMS.map((item) => NAV_KEYS.indexOf(item.key))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(NAV_ITEMS.map((item) => item.key)).size).toBe(NAV_ITEMS.length)
    expect(new Set(NAV_ITEMS.map((item) => item.to)).size).toBe(NAV_ITEMS.length)
  })

  it("only Approvals carries badgeKey pendingProposals", () => {
    const badged = NAV_ITEMS.filter((item) => item.badgeKey !== undefined)
    expect(badged.map((item) => [item.key, item.badgeKey])).toEqual([
      ["approvals", "pendingProposals"],
    ])
  })

  it("NavIcon draws an svg for every one of the nine NAV_KEYS", () => {
    expect(NAV_KEYS).toHaveLength(9)
    for (const name of NAV_KEYS) {
      const markup = renderToStaticMarkup(<NavIcon name={name} />)
      expect(markup, name).toMatch(/^<svg /)
      expect(markup, name).toContain('aria-hidden="true"')
    }
  })
})
