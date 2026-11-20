import { describe, expect, it } from "vitest"

// The catalog itself (not a copy): the picker must stay a subset of what the server defines.
import { roles, statements } from "@proof/auth/client"
import {
  KEY_ACTIONS,
  accessSummary,
  createdByLabel,
  expiryLabel,
  isUnused,
  maskedKey,
  permissionList,
  permissionOptions,
  secretNotice,
  toPermissionsRecord,
} from "./api-keys"

describe("permissionOptions", () => {
  it("offers only product resources, never approve or owner-only ones", () => {
    const all = permissionOptions(() => true)
    const keys = all.map((option) => option.key)
    expect(keys).toContain("project:read")
    expect(keys).toContain("run:steer")
    expect(keys).not.toContain("run:approve")
    expect(
      keys.some((key) => /^(sso|scim|subscription|twoFactor|organization|member)/.test(key)),
    ).toBe(false)
  })

  it("keeps only what the caller may grant", () => {
    const viewerLike = (permission: Record<string, string[]>) =>
      Object.values(permission)
        .flat()
        .every((action) => action === "read")
    expect(permissionOptions(viewerLike).map((option) => option.key)).toEqual([
      "project:read",
      "agent:read",
      "run:read",
    ])
  })
})

describe("toPermissionsRecord", () => {
  it("groups selected keys into the server's resource to actions record", () => {
    expect(toPermissionsRecord(["project:read", "project:create", "agent:read"])).toEqual({
      project: ["read", "create"],
      agent: ["read"],
    })
  })
})

describe("accessSummary", () => {
  it("names read-only keys, read and write keys, and keys with nothing", () => {
    expect(accessSummary(["project:read", "agent:read"])).toBe("Read only")
    expect(accessSummary(["project:read", "project:update"])).toBe("Read & write")
    expect(accessSummary([])).toBe("No access")
  })
})

describe("isUnused", () => {
  const now = new Date("2026-10-16T12:00:00Z")
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()

  it("flags a key not used for 90 days", () => {
    expect(isUnused({ lastUsedAt: daysAgo(91), createdAt: daysAgo(200) }, now)).toBe(true)
    expect(isUnused({ lastUsedAt: daysAgo(2), createdAt: daysAgo(200) }, now)).toBe(false)
  })

  it("counts a key never used from when it was created", () => {
    expect(isUnused({ lastUsedAt: null, createdAt: daysAgo(91) }, now)).toBe(true)
    expect(isUnused({ lastUsedAt: null, createdAt: daysAgo(3) }, now)).toBe(false)
  })
})

describe("secretNotice", () => {
  it("says the key is shown only once", () => {
    expect(secretNotice("CI deploy")).toBe("Copy “CI deploy” now. You won't see this key again.")
  })
})

describe("the picker against the permission catalog", () => {
  const everything = permissionOptions(() => true)

  it("offers only actions the catalog defines", () => {
    for (const option of everything) {
      const actions = (statements as Record<string, readonly string[]>)[option.resource]
      expect(actions, option.key).toContain(option.action)
    }
  })

  it("never offers run:approve, run:delete, or owner-only or org-admin resources", () => {
    const keys = everything.map((option) => option.key)
    expect(keys).not.toContain("run:approve")
    expect(keys).not.toContain("run:delete")
    for (const resource of [
      "sso",
      "scim",
      "subscription",
      "twoFactor",
      "organization",
      "member",
      "apiKey",
    ]) {
      expect(
        keys.some((key) => key.startsWith(`${resource}:`)),
        resource,
      ).toBe(false)
    }
  })

  it("lists the same actions as KEY_ACTIONS", () => {
    const expected = Object.entries(KEY_ACTIONS).flatMap(([resource, actions]) =>
      actions.map((action) => `${resource}:${action}`),
    )
    expect(everything.map((option) => option.key)).toEqual(expected)
  })

  it("is built from the seven roles the catalog defines", () => {
    expect(Object.keys(roles).sort()).toEqual([
      "admin",
      "approver",
      "billing",
      "member",
      "operator",
      "owner",
      "viewer",
    ])
  })
})

describe("display helpers", () => {
  it("flattens a permissions record into resource:action strings", () => {
    expect(permissionList({ project: ["read", "update"], run: ["steer"] })).toEqual([
      "project:read",
      "project:update",
      "run:steer",
    ])
  })

  it("masks the key to the stored start and never adds characters", () => {
    expect(maskedKey("ak_live_")).toBe("ak_live_••••")
    expect(maskedKey(null)).toBe("••••")
  })

  it("says No expiry for a key that never expires, and formats a date otherwise", () => {
    const format = (value: string) => `on ${value.slice(0, 10)}`
    expect(expiryLabel(null, format)).toBe("No expiry")
    expect(expiryLabel("2027-01-14T00:00:00.000Z", format)).toBe("on 2027-01-14")
  })

  it("names the creator, or a dash when it was not recorded", () => {
    expect(createdByLabel({ name: "Jordan Lee" })).toBe("Jordan Lee")
    expect(createdByLabel(null)).toBe("—")
  })
})
