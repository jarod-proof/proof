import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { credentialsPath, loadCredentials, saveCredentials } from "./config"

describe("credentialsPath", () => {
  it("prefers PROOF_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(credentialsPath({ PROOF_CONFIG_DIR: "/x" }, "/home/u")).toBe("/x/credentials.json")
    expect(credentialsPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(
      "/xdg/proof/credentials.json",
    )
    expect(credentialsPath({ XDG_CONFIG_HOME: "" }, "/home/u")).toBe(
      "/home/u/.config/proof/credentials.json",
    )
    expect(credentialsPath({}, "/home/u")).toBe("/home/u/.config/proof/credentials.json")
  })

  it("treats an empty PROOF_CONFIG_DIR as unset, not the working directory", () => {
    expect(credentialsPath({ PROOF_CONFIG_DIR: "" }, "/home/u")).toBe(
      "/home/u/.config/proof/credentials.json",
    )
  })
})

describe("credentials file", () => {
  let dir: string
  let path: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "proof-config-"))
    path = join(dir, "nested", "credentials.json")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads as empty when the file does not exist yet", async () => {
    expect(await loadCredentials(path)).toEqual({ profiles: {} })
  })

  it("round-trips a saved file, creating its directory owner-only", async () => {
    const creds = { current: "https://a.test", profiles: { "https://a.test": { clientId: "c" } } }
    await saveCredentials(path, creds)
    expect(await loadCredentials(path)).toEqual(creds)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700)
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true)
  })

  it("leaves no temp file behind after a save", async () => {
    await saveCredentials(path, { profiles: {} })
    const { readdir } = await import("node:fs/promises")
    expect(await readdir(join(dir, "nested"))).toEqual(["credentials.json"])
  })

  it("rejects a file that is not a credentials object", async () => {
    await saveCredentials(path, { profiles: {} })
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, "null")
    await expect(loadCredentials(path)).rejects.toThrow("not a credentials file")
  })

  it("surfaces read errors other than a missing file", async () => {
    // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path, { recursive: true })
    await expect(loadCredentials(path)).rejects.toThrow()
  })
})
