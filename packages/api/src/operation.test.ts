import { AppError } from "@proof/errors"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  defineOperation,
  defineRegistry,
  formatPermissions,
  invoke,
  operationsFor,
  pathParams,
} from "./operation"

const caller = {
  organizationId: "org1",
  actor: { type: "user" as const, userId: "u1" },
  grants: [{ note: ["read"] }],
  via: "session",
}

const getNote = defineOperation({
  name: "get_note",
  method: "GET",
  path: "/v1/notes/:id",
  summary: "Get a note",
  description: "Returns one note.",
  permissions: { note: ["read"] },
  input: z.object({ id: z.string(), verbose: z.coerce.boolean().optional() }),
  output: z.object({ id: z.string(), owner: z.string() }),
  handler: (input, ctx) => ({ id: input.id, owner: ctx.caller.organizationId }),
})

describe("defineOperation", () => {
  it("rejects names that aren't snake_case", () => {
    expect(() => defineOperation({ ...getNote, name: "GetNote" })).toThrow(/snake_case/)
  })

  it("rejects a path param missing from the input", () => {
    expect(() => defineOperation({ ...getNote, path: "/v1/notes/:noteId" })).toThrow(/:noteId/)
  })

  it("rejects a resource with no actions", () => {
    expect(() => defineOperation({ ...getNote, permissions: { note: [] } })).toThrow(/no actions/)
  })

  it("checks permissions against a catalog when made with operationsFor", () => {
    const define = operationsFor<{ note: readonly ["read", "write"] }>()
    expect(define({ ...getNote, permissions: { note: ["write"] } }).permissions).toEqual({
      note: ["write"],
    })
    // A permission outside the catalog is a type error: see operation.types.ts.
  })

  it("formats permissions", () => {
    expect(formatPermissions({ a: ["x", "y"], b: ["z"] })).toBe("a:x, a:y, b:z")
    expect(formatPermissions({})).toBe("")
  })

  it("lists path params", () => {
    expect(pathParams("/v1/a/:x/b/:y_2")).toEqual(["x", "y_2"])
  })
})

describe("fresh", () => {
  it("is kept on the operation as declared", () => {
    const op = defineOperation({ ...getNote, fresh: true })
    expect(op.fresh).toBe(true)
    expect(getNote.fresh).toBeUndefined()
  })
})

describe("defineRegistry", () => {
  it("rejects duplicate names and colliding routes", () => {
    expect(() => defineRegistry([getNote, getNote])).toThrow(/Duplicate operation name/)
    const other = defineOperation({ ...getNote, name: "other", path: "/v1/notes/:id" })
    expect(() => defineRegistry([getNote, other])).toThrow(/Duplicate route/)
  })

  it("returns the operations unchanged", () => {
    const ops = [getNote] as const
    expect(defineRegistry(ops)).toBe(ops)
  })
})

describe("invoke", () => {
  it("validates input and runs the handler", async () => {
    expect(await invoke(getNote, { id: "n1", verbose: "true" }, { caller })).toEqual({
      id: "n1",
      owner: "org1",
    })
  })

  it("refuses a caller without the permission", async () => {
    const noGrants = { caller: { ...caller, grants: [{ note: ["write"] }] } }
    const err = await invoke(getNote, { id: "n1" }, noGrants).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: "FORBIDDEN", message: "Missing permission: note:read" })
  })

  it("turns invalid input into BAD_REQUEST", async () => {
    await expect(invoke(getNote, undefined, { caller })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })

  it("turns an invalid handler result into an unexposed INTERNAL error", async () => {
    const broken = defineOperation({ ...getNote, handler: () => ({ id: 1 }) as never })
    const err = await invoke(broken, { id: "n1" }, { caller }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: "INTERNAL", expose: false })
  })
})

describe('person-only operations (auth: "person")', () => {
  const setAvatar = defineOperation({
    name: "set_avatar",
    method: "PUT",
    path: "/v1/me/avatar",
    summary: "Set your avatar",
    description: "Web app only.",
    auth: "person",
    permissions: {},
    input: z.object({ image: z.string() }),
    output: z.object({ userId: z.string() }),
    handler: (_input, ctx) => ({
      userId: ctx.caller.actor.type === "user" ? ctx.caller.actor.userId : "",
    }),
  })

  it("runs for a session, with its hooks", async () => {
    const before = vi.fn()
    expect(await invoke(setAvatar, { image: "x" }, { caller }, { hooks: { before } })).toEqual({
      userId: "u1",
    })
    expect(before).toHaveBeenCalledOnce()
  })

  it("refuses API keys and OAuth tokens before reading the input", async () => {
    for (const via of ["api-key", "oauth"]) {
      await expect(invoke(setAvatar, {}, { caller: { ...caller, via } })).rejects.toMatchObject({
        code: "FORBIDDEN",
        hint: expect.stringContaining("web app"),
      })
    }
  })
})

describe('operator operations (audience: "operator")', () => {
  const rampFlag = defineOperation({
    name: "ramp_flag",
    method: "PATCH",
    path: "/v1/flags/:key",
    summary: "Ramp a flag",
    description: "Operator only.",
    audience: "operator",
    permissions: { note: ["update"] },
    input: z.object({ key: z.string() }),
    output: z.object({ key: z.string() }),
    handler: (input) => ({ key: input.key }),
  })
  const isOperator = (c: { organizationId: string }) => c.organizationId === "op"

  it("runs for the operator organization's callers", async () => {
    const operator = { ...caller, organizationId: "op", grants: [{ note: ["update"] }] }
    expect(await invoke(rampFlag, { key: "f" }, { caller: operator }, { isOperator })).toEqual({
      key: "f",
    })
  })

  it("refuses everyone else before permissions and input, and everyone when unconfigured", async () => {
    // No grants and no input: the audience is checked first, so its hint is what comes back.
    const outsider = { ...caller, grants: [] }
    await expect(invoke(rampFlag, {}, { caller: outsider }, { isOperator })).rejects.toMatchObject({
      code: "FORBIDDEN",
      hint: expect.stringContaining("operator organization"),
    })
    const operator = { ...caller, organizationId: "op", grants: [{ note: ["update"] }] }
    await expect(invoke(rampFlag, { key: "f" }, { caller: operator })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("can't be public", () => {
    expect(() =>
      defineOperation({
        ...rampFlag,
        auth: "none",
        permissions: {},
        name: "open_ramp",
        handler: (input) => ({ key: input.key }),
      }),
    ).toThrow(/operator operation needs a caller/)
  })
})

describe('public operations (auth: "none")', () => {
  const signup = defineOperation({
    name: "open_signup",
    method: "POST",
    path: "/v1/open-signup",
    summary: "Sign up",
    description: "Creates an account from an email address.",
    auth: "none",
    permissions: {},
    input: z.object({ email: z.string() }),
    output: z.object({ ip: z.string() }),
    handler: (input, ctx) => ({ ip: `${input.email}@${ctx.public.ip}` }),
  })

  it("refuses permissions: a public operation has no organization to grant them in", () => {
    expect(() =>
      defineOperation({
        name: "open_read",
        method: "GET",
        path: "/v1/open",
        summary: "Read",
        description: "Reads.",
        auth: "none",
        permissions: { note: ["read"] },
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      }),
    ).toThrow(/takes no permissions/)
  })

  it("runs with no caller and no hooks, and the handler gets the client ip", async () => {
    const before = vi.fn()
    const after = vi.fn()
    const result = await invoke(
      signup,
      { email: "a@example.com" },
      { public: { ip: "203.0.113.7" } },
      { hooks: { before, after } },
    )
    expect(result).toEqual({ ip: "a@example.com@203.0.113.7" })
    expect(before).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it("still validates its input", async () => {
    await expect(invoke(signup, {}, { public: { ip: "203.0.113.7" } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })
})
