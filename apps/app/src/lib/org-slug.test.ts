import { describe, expect, it } from "vitest"

import { RESERVED_ORG_SLUGS } from "@proof/auth/client"

import { SLUG_MAX_LENGTH, slugProblem, slugify } from "./org-slug"

describe("slugProblem", () => {
  it("accepts lowercase letters, digits and hyphens", () => {
    expect(slugProblem("acme-labs2")).toBeNull()
    expect(slugProblem("9lives")).toBeNull()
  })

  it("refuses dots, capitals, spaces and leading hyphens", () => {
    for (const bad of ["acme.co", "Acme", "acme labs", "-acme"]) {
      expect(slugProblem(bad), bad).toBe("shape")
    }
  })

  it("refuses empty and over-long slugs", () => {
    expect(slugProblem("")).toBe("empty")
    expect(slugProblem("a".repeat(SLUG_MAX_LENGTH + 1))).toBe("shape")
  })

  it("refuses every reserved slug, whatever the case", () => {
    for (const slug of RESERVED_ORG_SLUGS) {
      expect(slugProblem(slug), slug).toBe("reserved")
    }
    expect(slugProblem("Dashboard".toLowerCase())).toBeNull()
  })
})

describe("slugify", () => {
  it("turns a name into a slug", () => {
    expect(slugify("Acme Labs, Ltd.")).toBe("acme-labs-ltd")
    expect(slugify("  Café Déjà  Vu ")).toBe("cafe-deja-vu")
    expect(slugify("---")).toBe("")
  })

  it("never returns a slug the shape check refuses", () => {
    const slug = slugify("x".repeat(200) + " !!!")
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH)
    expect(slug.endsWith("-")).toBe(false)
  })
})
