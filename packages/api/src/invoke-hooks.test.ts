import { AppError, setErrorReporter } from "@proof/errors"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { PermissionSet } from "./permissions"
import {
  defineOperation,
  type InvokeEvent,
  type InvokeOutcome,
  invoke,
  missingPermissions,
} from "./operation"

afterEach(() => setErrorReporter(undefined))

const caller = {
  organizationId: "org1",
  actor: { type: "user" as const, userId: "u1" },
  grants: [{ note: ["read"] }],
  via: "session",
}

const makeNote = defineOperation({
  name: "make_note",
  method: "POST",
  path: "/v1/notes",
  summary: "Make a note",
  description: "Creates a note.",
  permissions: { note: ["read", "create"] },
  input: z.object({ text: z.string() }),
  output: z.object({ id: z.string() }),
  handler: vi.fn(() => ({ id: "n1" })),
})

describe("invoke hints", () => {
  it("attaches a permission hint built from the closest grant", async () => {
    const hint = vi.fn(() => "Use an API key with note:create")
    const err = await invoke(
      makeNote,
      { text: "hi" },
      { caller: { ...caller, grants: [{ note: ["read"] }] } },
      { permissionHint: hint },
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: "FORBIDDEN",
      message: "Missing permission: note:create",
      hint: "Use an API key with note:create",
    })
    expect(hint).toHaveBeenCalledWith({ note: ["create"] })
  })

  it("leaves the hint unset without a permissionHint option", async () => {
    const err = await invoke(makeNote, { text: "hi" }, { caller }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).hint).toBeUndefined()
  })
})

describe("missingPermissions", () => {
  it("returns the whole need when there are no grants", () => {
    expect(missingPermissions([], { note: ["read", "create"] })).toEqual({
      note: ["read", "create"],
    })
  })

  it("picks the grant that leaves the fewest actions missing", () => {
    const need = { note: ["read", "create"], project: ["read"] }
    const grants: PermissionSet[] = [{ project: ["read"] }, { note: ["read"], project: ["read"] }]
    expect(missingPermissions(grants, need)).toEqual({ note: ["create"] })
  })

  it("is empty when nothing is needed", () => {
    expect(missingPermissions([], {})).toEqual({})
  })
})

describe("invoke before/after hooks", () => {
  const writeCaller = { ...caller, grants: [{ note: ["read", "create"] }] }

  it("calls after with ok outcome and replayed false after a normal run", async () => {
    const after = vi.fn(async (_e: { outcome: InvokeOutcome }) => {})
    const result = await invoke(
      makeNote,
      { text: "hi" },
      { caller: writeCaller },
      {
        hooks: { after },
      },
    )
    expect(result).toEqual({ id: "n1" })
    expect(after).toHaveBeenCalledTimes(1)
    expect(after.mock.calls[0]?.[0].outcome).toEqual({
      ok: true,
      result: { id: "n1" },
      replayed: false,
    })
  })

  it("passes the idempotency key and op to hooks", async () => {
    const before = vi.fn(async (_e: InvokeEvent) => undefined)
    await invoke(
      makeNote,
      { text: "hi" },
      { caller: writeCaller, idempotencyKey: "k1" },
      { hooks: { before } },
    )
    expect(before.mock.calls[0]?.[0]).toMatchObject({
      op: makeNote,
      input: { text: "hi" },
      ctx: { idempotencyKey: "k1" },
    })
  })

  it("short-circuits with the stored result, skipping the handler, and marks it replayed", async () => {
    const handler = vi.fn(() => ({ id: "fresh" }))
    const op = defineOperation({ ...makeNote, handler })
    const after = vi.fn(async (_e: { outcome: InvokeOutcome }) => {})
    const stored = { id: "stored" }
    // A stored response is returned as-is: it is not validated again.
    const result = await invoke(
      op,
      { text: "hi" },
      { caller: writeCaller },
      {
        hooks: {
          before: async () => ({ result: stored }),
          after,
        },
      },
    )
    expect(result).toBe(stored)
    expect(handler).not.toHaveBeenCalled()
    expect(after.mock.calls[0]?.[0].outcome).toEqual({ ok: true, result: stored, replayed: true })
  })

  it("lets before abort with an AppError and skips after, since the handler was not reached", async () => {
    const handler = vi.fn(() => ({ id: "n1" }))
    const op = defineOperation({ ...makeNote, handler })
    const after = vi.fn(async (_e: { outcome: InvokeOutcome }) => {})
    const err = await invoke(
      op,
      { text: "hi" },
      { caller: writeCaller },
      {
        hooks: {
          before: async () => {
            throw new AppError("CONFLICT", "Key reused with a different body")
          },
          after,
        },
      },
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: "CONFLICT" })
    expect(handler).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it("reports a failing handler to after as an error outcome and rethrows it unchanged", async () => {
    const boom = new Error("db down")
    const op = defineOperation({
      ...makeNote,
      handler: () => {
        throw boom
      },
    })
    const after = vi.fn(async (_e: { outcome: InvokeOutcome }) => {})
    const err = await invoke(
      op,
      { text: "hi" },
      { caller: writeCaller },
      { hooks: { after } },
    ).catch((e: unknown) => e)
    expect(err).toBe(boom)
    const outcome = after.mock.calls[0]?.[0].outcome
    expect(outcome?.ok).toBe(false)
    expect(outcome).toMatchObject({ error: { code: "INTERNAL", message: "db down" } })
  })

  it("reports an invalid handler result to after as INTERNAL", async () => {
    const op = defineOperation({ ...makeNote, handler: () => ({ id: 1 }) as never })
    const after = vi.fn(async (_e: { outcome: InvokeOutcome }) => {})
    await expect(
      invoke(op, { text: "hi" }, { caller: writeCaller }, { hooks: { after } }),
    ).rejects.toMatchObject({ code: "INTERNAL" })
    expect(after.mock.calls[0]?.[0].outcome).toMatchObject({
      ok: false,
      error: { code: "INTERNAL" },
    })
  })

  it("swallows and reports errors thrown by after without changing the response", async () => {
    const reporter = vi.fn()
    setErrorReporter(reporter)
    const after = vi.fn(async () => {
      throw new Error("audit write failed")
    })
    const result = await invoke(
      makeNote,
      { text: "hi" },
      { caller: writeCaller },
      {
        hooks: { after },
      },
    )
    expect(result).toEqual({ id: "n1" })
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ message: "audit write failed" }),
      expect.objectContaining({ operation: "make_note", phase: "after" }),
    )
  })

  it("does not change a handler error when after throws", async () => {
    setErrorReporter(vi.fn())
    const boom = new AppError("NOT_FOUND", "gone")
    const op = defineOperation({
      ...makeNote,
      handler: () => {
        throw boom
      },
    })
    const after = vi.fn(async () => {
      throw new Error("hook broke")
    })
    await expect(
      invoke(op, { text: "hi" }, { caller: writeCaller }, { hooks: { after } }),
    ).rejects.toBe(boom)
  })
})
