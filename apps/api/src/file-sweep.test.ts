import { createLogger } from "@proof/logger"
import { createMemoryStore, type FileStore } from "@proof/storage"
import { describe, expect, it } from "vitest"

import { fileSweep } from "./file-sweep"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

/** A logger whose lines the test reads. */
function recordingLogger() {
  const lines: {
    level: number
    msg: string
    prefix?: string
    deleted?: number
    skipped?: number
  }[] = []
  const logger = createLogger({
    level: "info",
    destination: { write: (line) => lines.push(JSON.parse(line)) },
  })
  return { logger, lines }
}

describe("fileSweep", () => {
  it("maps a deleted person and organization to their prefixes and logs the counts", async () => {
    const files = createMemoryStore({ driver: "memory", publicUrl: "http://test/files" })
    await files.put("user/u1/avatar-a.png", PNG, "image/png")
    await files.put("org/o1/logo-a.png", PNG, "image/png")
    await files.put("org/o1/logo-b.png", PNG, "image/png")
    await files.put("org/o2/logo-a.png", PNG, "image/png")
    const { logger, lines } = recordingLogger()
    const sweep = fileSweep(files, logger)

    await sweep({ userId: "u1" })
    await sweep({ organizationId: "o1" })
    expect([...files.files.keys()]).toEqual(["org/o2/logo-a.png"])
    expect(
      lines.map(({ msg, prefix, deleted, skipped }) => ({ msg, prefix, deleted, skipped })),
    ).toEqual([
      { msg: "swept a deleted owner's files", prefix: "user/u1/", deleted: 1, skipped: 0 },
      { msg: "swept a deleted owner's files", prefix: "org/o1/", deleted: 2, skipped: 0 },
    ])
  })

  it("warns about keys the store listed but would not sweep", async () => {
    const store: FileStore = {
      ...createMemoryStore({ driver: "memory", publicUrl: "http://test/files" }),
      deletePrefix: async () => ({ deleted: 1, skipped: 2 }),
    }
    const { logger, lines } = recordingLogger()
    await fileSweep(store, logger)({ organizationId: "o1" })
    expect(lines.at(-1)).toMatchObject({ level: 40, prefix: "org/o1/", skipped: 2 })
  })

  it("does nothing without a file store, and lets a store failure reach auth's reporter", async () => {
    const { logger, lines } = recordingLogger()
    await fileSweep(undefined, logger)({ userId: "u1" })
    expect(lines).toEqual([])
    const failing: FileStore = {
      ...createMemoryStore({ driver: "memory", publicUrl: "http://test/files" }),
      deletePrefix: async () => {
        throw new Error("AccessDenied")
      },
    }
    await expect(fileSweep(failing, logger)({ userId: "u1" })).rejects.toThrow("AccessDenied")
  })
})
