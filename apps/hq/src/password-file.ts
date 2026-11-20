// The one channel create-founder hands a password through: a file the operator names, created
// private (mode 0600) and never over an existing one. Not stdout, not a log.
import { chmod, open, unlink } from "node:fs/promises"

export interface PasswordFile {
  /** Writes the password and a newline, flushes, and makes sure the mode is 0600. */
  deliver: (password: string) => Promise<void>
  /** Closes the file, keeping what was written. */
  close: () => Promise<void>
  /** Closes and deletes it: nothing came of the run, so nothing that looks like a password stays. */
  discard: () => Promise<void>
}

/** Creates `path` (empty, 0600). Throws, creating nothing, when it already exists or cannot be made. */
export async function openPasswordFile(path: string): Promise<PasswordFile> {
  // `wx`: fail if the path exists, so a password is never written into a file that was there.
  const file = await open(path, "wx", 0o600)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await file.close()
  }
  return {
    deliver: async (password) => {
      await file.writeFile(`${password}\n`)
      await file.sync()
      // The umask can only narrow a mode given at creation; this makes 0600 certain.
      await chmod(path, 0o600)
    },
    close,
    discard: async () => {
      await close().catch(() => undefined)
      await unlink(path).catch(() => undefined)
    },
  }
}
