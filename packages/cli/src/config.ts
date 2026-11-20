import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** What the CLI keeps for one API origin: the OAuth client it registered and its tokens. */
export interface Profile {
  clientId: string
  accessToken?: string
  refreshToken?: string
  /** Epoch milliseconds when the access token stops being valid. */
  expiresAt?: number
  scope?: string
}

export interface Credentials {
  /** The origin commands use when none is given. Set by the last login. */
  current?: string
  profiles: Record<string, Profile>
}

/** Where credentials live: PROOF_CONFIG_DIR, else $XDG_CONFIG_HOME/proof, else ~/.config/proof. */
export function credentialsPath(env: Record<string, string | undefined>, home = homedir()): string {
  // An empty value counts as unset, or the token file would land in the working directory.
  const dir = env.PROOF_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "proof")
  return join(dir, "credentials.json")
}

export async function loadCredentials(path: string): Promise<Credentials> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {} }
    throw error
  }
  const parsed = JSON.parse(text) as Partial<Credentials>
  if (typeof parsed !== "object" || parsed === null || typeof parsed.profiles !== "object") {
    throw new Error(`${path} is not a credentials file; delete it and run proof login`)
  }
  return { current: parsed.current, profiles: parsed.profiles }
}

/**
 * Writes the file owner-only (0600) in an owner-only directory, through a temp file and a rename so
 * a crash never leaves a half-written token store.
 */
export async function saveCredentials(path: string, credentials: Credentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
}
