// `pnpm --filter @proof/hq mint-agent-key --email <founder email>`: an hq API key with the agent's
// scope, made on the server for a founder's organization, printed once on stdout.
//
// Run by whoever operates hq (it needs HQ_DATABASE_URL and BETTER_AUTH_SECRET, so shell access to the
// deployment), and the key goes straight into the org's vault as HQ_AGENT_API_KEY. A key's
// permissions can only be set server-side (better-auth refuses them over HTTP), which is also why
// no API caller can mint one with more. The scope is the agent's and nothing more: read the brain,
// propose, record runs and spend, and ask for a spend grant (`hq_spend:request`: a pending request a
// founder redeems with a Slack click). Decide, edit and grant are person-only and can never be on a
// key. Keys minted before the grant-request change lack `request`: mint a new one, put it in the
// vault, and revoke the old.
import { createDb, member, user } from "@proof/db"
import { and, eq } from "drizzle-orm"

import { createHqAuth } from "./auth"
import { isFounder } from "./data/founders"
import { hqEnv } from "./env"

const AGENT_SCOPE = {
  hq_entry: ["read"],
  hq_proposal: ["read", "create"],
  hq_run: ["read", "create", "update"],
  // `request` asks for a grant (a pending request a founder redeems in Slack); grant is never here.
  hq_spend: ["read", "record", "request"],
}

const flag = process.argv.indexOf("--email")
const email = flag === -1 ? undefined : process.argv[flag + 1]?.trim().toLowerCase()
if (!email) {
  process.stderr.write("usage: mint-agent-key --email <a founder's email>\n")
  process.exit(2)
}

const config = hqEnv()
const db = createDb(config.databaseUrl)
const [person] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
if (!person || !(await isFounder(db, person.id))) {
  process.stderr.write(`${email} is not a founder in hq's founders table.\n`)
  process.exit(1)
}
const [owned] = await db
  .select({ organizationId: member.organizationId })
  .from(member)
  .where(and(eq(member.userId, person.id), eq(member.role, "owner")))
if (!owned) {
  process.stderr.write(`${email} owns no organization to hold a key.\n`)
  process.exit(1)
}
const auth = createHqAuth(db, { ...config, allowSignUp: false })
const created = await auth.api.createApiKey({
  body: {
    organizationId: owned.organizationId,
    userId: person.id,
    name: `agent ${new Date().toISOString().slice(0, 10)}`,
    permissions: AGENT_SCOPE,
  },
})
process.stdout.write(`${created.key}\n`)
process.exit(0)
