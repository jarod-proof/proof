// The one place the acceptance run reads its environment. It is a *.config.ts file on purpose: the
// org's baseline rule "read env vars through @<org>/env" excludes config files, and this run is
// configured by the shell (op run), not by the server's env package.

/** Why the journeys skip, or false when they run. Evaluated when a file registers its test. */
export const acceptanceSkip: string | false =
  process.env.FACTORY_ACCEPTANCE === "1" && process.env.HQ_BASE_URL
    ? false
    : "acceptance runs only against a deployed org: set FACTORY_ACCEPTANCE=1 and HQ_BASE_URL"

/** The value of a required environment variable; the error names it and never its value. */
export function need(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (the acceptance run reads it from the vault)`)
  return value
}
