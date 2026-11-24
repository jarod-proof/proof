import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { ADMIN_PARITY } from "./admin-parity"
import { routeTree } from "./route-tree"

const WEB_SRC = fileURLToPath(new URL(".", import.meta.url))
const ADMIN_ROUTES = fileURLToPath(new URL("../../src/admin/routes.tsx", import.meta.url))

/** Every `METHOD /admin/path` that createAdminApp registers, read from its source. */
function registeredAdminRoutes(): string[] {
  const source = readFileSync(ADMIN_ROUTES, "utf8")
  const found: string[] = []
  const routeCall = /admin\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)/g
  for (const [, method = "", path = ""] of source.matchAll(routeCall)) {
    found.push(`${method.toUpperCase()} /admin${path}`)
  }
  return found
}

/** Every `admin.<method>(` call except `use`, in any form, so a route the regex above cannot read is still counted. */
function adminCallCount(): number {
  const source = readFileSync(ADMIN_ROUTES, "utf8")
  return [...source.matchAll(/\badmin\.(\w+)\(/g)].filter(([, name]) => name !== "use").length
}

const ASSET_ROWS = ["GET /admin/admin.css", "GET /admin/login.js"]

/** Every full path in the SPA route tree, read from route-tree.ts. */
function treePaths(): Set<string> {
  const paths = new Set<string>()
  // fullPath is only set once a router is built, so join each route's own `path` down the tree.
  type Node = { children?: unknown; options?: { path?: string } }
  const walk = (route: Node, prefix: string) => {
    const children = route.children
    if (!children) return
    const list = (Array.isArray(children) ? children : Object.values(children)) as Node[]
    for (const child of list) {
      let full = prefix
      const own = child.options?.path
      if (own !== undefined) {
        full = `${prefix}/${own}`.replace(/\/+/g, "/")
        if (full.length > 1) full = full.replace(/\/$/, "")
        paths.add(full)
      }
      walk(child, full)
    }
  }
  walk(routeTree as unknown as Node, "")
  return paths
}

/** The SPA is mounted at /app, so /app/approvals is the route `/approvals` in the tree. */
const treePathOf = (spa: string) => spa.replace(/^\/app(?=\/|$)/, "") || "/"

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    const isSource = [".ts", ".tsx"].includes(extname(name))
    return isSource && !name.includes(".test.") ? [path] : []
  })
}

describe("ADMIN_PARITY", () => {
  it("every route createAdminApp registers has a parity row, and every covered row names a route in route-tree.ts", () => {
    const registered = registeredAdminRoutes().sort()
    const rows = ADMIN_PARITY.map((row) => row.adminPath).sort()
    expect(registered).toContain("GET /admin/login")
    expect(rows).toEqual(registered)
    expect(adminCallCount()).toBe(ADMIN_PARITY.length)

    const tree = treePaths()
    for (const row of ADMIN_PARITY.filter((r) => r.status === "covered")) {
      if (row.spa === null) {
        expect(ASSET_ROWS, row.adminPath).toContain(row.adminPath)
        continue
      }
      expect(row.spa, row.adminPath).toMatch(/^\/app(\/|$)/)
      expect(tree.has(treePathOf(row.spa)), `${row.adminPath} -> ${row.spa}`).toBe(true)
    }
  })

  it("has no row marked gap that names an SPA path, and every gap names what is missing", () => {
    for (const row of ADMIN_PARITY.filter((r) => r.status === "gap")) {
      expect(row.spa, row.adminPath).toBeNull()
      expect(row.note.length, row.adminPath).toBeGreaterThan(0)
    }
  })

  it("records the two asset rows and GET /admin/ as covered", () => {
    const byPath = new Map(ADMIN_PARITY.map((row) => [row.adminPath, row]))
    for (const asset of ASSET_ROWS) {
      expect(byPath.get(asset), asset).toMatchObject({ status: "covered", spa: null })
    }
    expect(byPath.get("GET /admin/")).toMatchObject({ status: "covered", spa: "/app/approvals" })
  })

  it("records the two known gaps and the covered proposal and login rows", () => {
    const byPath = new Map(ADMIN_PARITY.map((row) => [row.adminPath, row]))
    expect(byPath.get("GET /admin/entries/:id")?.status).toBe("gap")
    expect(byPath.get("GET /admin/spend")?.status).toBe("gap")
    expect(byPath.get("GET /admin/proposals")).toMatchObject({
      status: "covered",
      spa: "/app/approvals",
    })
    expect(byPath.get("POST /admin/proposals/:id/decision")).toMatchObject({
      status: "covered",
      spa: "/app/approvals",
    })
    expect(byPath.get("GET /admin/login")).toMatchObject({ status: "covered", spa: "/app/sign-in" })
  })

  it("the Approvals History link and /admin/entries/:id are the only links from the app to /admin", () => {
    const hits: string[] = []
    for (const file of sourceFiles(WEB_SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const isComment = /^\s*(\/\/|\*|\/\*)/.test(line)
          if (!isComment && /["'`]\/admin/.test(line))
            hits.push(`${file.slice(WEB_SRC.length)}:${index + 1}:${line}`)
        })
    }
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatch(/^pages\/approvals-page\.tsx:\d+:.*\/admin\/entries\//)
  })
})
