# Deploy runbook

What the real-service run proved you must know before and after the first Vercel deploy.

## Vercel

- Hobby teams only allow cron schedules of 15 minutes or more, with up to 15 minutes of jitter. A
  daily digest is fine. A 1-minute schedule is refused at deploy and fails the whole deployment.
- Every Vercel build prepares 6 Sandbox templates. That counts against Sandbox usage, so expect it
  on every deploy, not only the first.
- A Blob store is needed. Create one and connect it to the project before the first deploy.
- The `<project>.vercel.app` host the CLI prints is a guess until the deploy: read the real host
  from the project's Domains page. On a shared Vercel team, pick a name that is unique there.
  The CLI names the projects `<name>-hq` and `<name>-agent`, where `<name>` is the new-org name argument; never rename them, steps 04, 07 and 09 look them up by that name.

## Slack

- Paste the Event Subscriptions and Interactivity Request URLs exactly: `https://<agent-host>/eve/v1/slack`.
  No trailing comma, period or space (copy only the URL, not the punctuation around it).
- Interactivity is not verified on save. A stray character shows up only as "could not handle the
  payload" in Slack and as a 404 in the Vercel logs.
- After the deploy (step 09), re-check both URLs, and that Event Subscriptions shows Verified.
- Invite the bot to the digest channel and copy the channel id into `SLACK_DIGEST_CHANNEL_ID`:
  right-click the channel, View channel details, the id is at the bottom. The bot has no
  `channels:read`, so it cannot look the id up.

## GitHub App

A new App has no webhook and no events, and neither can be set by API. Set them in the App's
settings: webhook Active, URL `https://<agent-host>/eve/v1/github`, content type
`application/json`, the value of the vault item `GITHUB_WEBHOOK_SECRET` as the Secret, SSL
verification on; events Issues, Issue comment, Pull request, Pull request review comment and Check suite (the agent's red-CI fix
loop fires on it; Workflow job is not needed). Install it with "Only select repositories": the org's
monorepo only. The vault items are one per name, each with one field `credential`: `GITHUB_APP_ID`,
`GITHUB_INSTALLATION_ID` (the number at the end of `/settings/installations/<id>`),
`GITHUB_APP_PRIVATE_KEY` (General > Private keys > Generate a private key, a .pem) and
`GITHUB_WEBHOOK_SECRET`. Permissions: Contents, Issues, Pull requests read and write; Actions,
Checks, Commit statuses, Metadata read; not Workflows.

## An eve or Foreman-based agent

The org agent defaults to the label `agent:build` and the branch prefix `agent/`, and the env
template sets `FACTORY_LABEL=agent:build` and `FACTORY_BRANCH_PREFIX=agent/` on it to make that
explicit. A stock eve/Foreman deploy defaults to `factory` and `factory/`: set both variables there.
