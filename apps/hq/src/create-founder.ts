// `pnpm --filter @proof/hq create-founder --email <e> --slack-id <U..> --password-out <path>`: make a
// founder's account on the server, with a verified address and a generated password, and link
// their `founders` row. A deployed hq has no public sign-up (HQ_ALLOW_SIGNUP stays off), so this
// is the only way a founder's account comes to exist there.
//
// Run by whoever operates hq (it needs HQ_DATABASE_URL and BETTER_AUTH_SECRET). The password is
// written ONLY to the file named by --password-out, created with mode 0600 and never overwritten:
// never to stdout, stderr or a log. Hand it to the founder over a channel you trust (the vault),
// delete the file, and have them change it at first sign-in. stdout gets the account's id and the
// HQ_FOUNDERS entry to add (`id:<user id>=<slack user id>`): a deployed hq takes founders by id.
// It refuses when HQ_ALLOW_SIGNUP is on in a deployed env, and when the address already has an
// account, verified or not (an unverified one is a squatter's).
import { createDb } from "@proof/db"

import { createHqAuth } from "./auth"
import { CreateFounderRefused, createFounder } from "./create-founder-account"
import { hqEnv } from "./env"
import { openPasswordFile } from "./password-file"

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]?.trim()
}

const email = arg("--email")
const slackId = arg("--slack-id")
const passwordOut = arg("--password-out")
if (!email || !slackId || !passwordOut) {
  process.stderr.write(
    "usage: create-founder --email <address> --slack-id <U01ABC...> --password-out <file>\n" +
      "  The generated password is written to <file> (mode 0600, must not exist), never printed.\n",
  )
  process.exit(2)
}

const config = hqEnv()
const db = createDb(config.databaseUrl)
const auth = createHqAuth(db, { ...config, allowSignUp: true })

// Create the file first, empty and private, so a path that cannot be written stops us before
// anything exists.
const file = await openPasswordFile(passwordOut).catch((error: unknown) => {
  process.stderr.write(
    `Cannot create ${passwordOut}: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  return process.exit(1)
})

try {
  const created = await createFounder(
    {
      db,
      auth,
      now: () => new Date(),
      env: { nodeEnv: config.nodeEnv, allowSignUp: config.allowSignUp },
      deliverPassword: file.deliver,
    },
    { email, slackUserId: slackId },
  )
  await file.close()
  process.stdout.write(
    `Created the founder account ${created.userId}.\n` +
      `Password written to ${passwordOut} (mode 0600). Hand it over through the vault, then delete it.\n` +
      `Add this to HQ_FOUNDERS, then run pnpm hq:predeploy and redeploy (a local hq: restart):\n` +
      `  ${created.entry}\n`,
  )
  process.exit(0)
} catch (error) {
  // No founder came of this run: do not leave a file that looks like a working password.
  await file.discard()
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(error instanceof CreateFounderRefused ? 1 : 3)
}
