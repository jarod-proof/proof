---
name: proof
description: Use the Proof API from an agent: connect over MCP, sign in headless with the device grant, create or claim an account, and call operations safely. Use when the user asks to do anything in Proof, connect Proof to an agent or CI, or write code against the Proof API.
---

# Proof


Proof exposes the same operations four ways. Pick the first that fits:

1. **MCP** (best inside an agent): `https://api.example.com/mcp` (Streamable HTTP). The client signs the
   person in with OAuth on first use; no key is pasted. Tools are the operations below, except `signup`,
  which is REST only.
2. **REST** (scripts, CI, server code): JSON over HTTPS, with an API key or an OAuth access token.
3. **OpenAPI** for generated clients: `https://api.example.com/openapi.json`.
4. **CLI** (terminal, CI): `npx @proof/cli login` signs in with the device grant, then
   `npx @proof/cli call <operation>` runs any operation and `npx @proof/cli ops` lists them. Output is JSON.

Install snippets for each client are in `https://api.example.com/llms.txt` under "Install".

## Authenticate

Every credential acts in one organization (workspace) and sees only that organization's data.

- **API key**: an organization admin creates one with exactly the permissions it needs (for example
  `project: read`). Send `x-api-key: sk_...` or `Authorization: Bearer sk_...`. Keep it in an env var such
  as `PROOF_API_KEY`; never paste it into code or chat.
- **OAuth, interactive**: the MCP client discovers it from `/.well-known/oauth-protected-resource/mcp`. The
  person picks the organization and approves scopes.
- **OAuth, headless (device grant)**: for CI and machines with no browser. Register a public client that lists
  the device grant (`urn:ietf:params:oauth:grant-type:device_code`) and refresh token; request a device code
  for `resource` = `https://api.example.com/mcp`; show the person the verification URL and user code; poll the
  token endpoint at the returned interval until it issues an access token. Request the offline_access scope
  so a refresh token is issued: without it the client can't renew access, and the refresh token is revoked if
  the approving web session signs out. Add `admin` only to create API keys or manage members and agents.
  Refresh with the refresh token.
  The token acts in the organization the approving person had active. The full sequence is in llms.txt.

Check a credential first. `whoami` names the organization, the grants, today's usage and the plan
with its features and limits:

```sh
curl -s https://api.example.com/v1/whoami -H "x-api-key: $PROOF_API_KEY"
```

## Scopes

OAuth scopes are coarse. A token may do what one of the person's roles allows and what its scopes allow:

- `read`: read projects, API keys, workspace agents and runs
- `write`: create, update and delete projects and workspace agents; start and drive runs
- `admin`: organization settings, members, invitations and API keys

A tool you can't see, or a `FORBIDDEN` error, means the credential lacks that permission. The error's hint
names the scope or key permission that would cover it; ask the person for that one.

## Sign up without a credential

An agent with no account can call `signup` (`POST /v1/signup`, body `{ "email", "name?" }`). It is the one
operation that takes no credential. The response carries an API key and `claimUrlSentTo`. That key works at a
low daily limit (`limits.requestsPerDay`) until the person opens the claim email sent to that address. Give
them the address to check, and don't invent one. Unclaimed accounts that exceed the limit get `RATE_LIMITED`.

The signup key is temporary (`apiKeyEndsWhenClaimed: true`): it stops working the moment the person claims
the account, because whoever called signup holds it. Tell the person this when you give them the address.
After the claim, calls with the key get `UNAUTHORIZED` with a hint; sign in with the device grant (see Authenticate),
which the person approves, and use that token from then on.

## Find operations

Read `https://api.example.com/llms.txt` for the list, and `llms-full.txt` for every operation's input, output
and a working example. Don't guess parameters: the schemas are exact.

## Write safely

- **Idempotency**: send a unique `Idempotency-Key` header with every write (over MCP, pass the optional
  `idempotencyKey` argument). A retry with the same key and the same body returns the first response and runs
  nothing twice. The same key with a different body is `CONFLICT`. A key is kept for 24 hours. While the first
  call is still running a retry gets `CONFLICT`; a call that never finished frees its key after 5 minutes.
- **Pagination**: list operations take `limit` (1 to 100) and `cursor`, and return `nextCursor`. Pass
  `nextCursor` back as `cursor`; it is `null` on the last page. Don't assume one call returns everything.
- **Rate limits and quota**: a `429` is `RATE_LIMITED`. Read the `Retry-After` header (seconds) and wait that
  long before retrying. The `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers show the
  daily count. `whoami` reports the same usage. The daily limit depends on the plan (Free 10,000, Pro 100,000,
  Team unlimited): on an unlimited plan the headers are not sent and the usage limit in `whoami` is null.

## Workspace agents and runs

An organization can configure workspace agents (`list_agents`, `create_agent`). Each start is a run
(`start_run`) with a status: queued, running, needs_you (waiting for a person), done or failed. Drive a run
as the agent: `update_run` to running, `append_run_step` and `update_run_step` for its steps, and `update_run`
with the footprint so far (energy, tokens, tool calls). Finish with `update_run` to done or failed.

Before any action a person must allow, call `request_approval` with the exact action and its content. Don't
take that action until `get_run` shows the approval as approved. A decision takes effect 30 seconds after the
person makes it, and until then the approval reads as pending, so wait for it. A denied approval must not be
taken. `update_run` refuses to finish a run while an approval blocks it.

People decide approvals and steer runs (`decide_approval`, `undo_approval`, `steer_run`, `defer_run`) in the
web app. A key or an OAuth token can't decide. Read `steer_run` messages with `get_run`, and follow them.

## Connected agents

Keys and OAuth clients connected to an organization are listed by `list_connected_agents`, each with an id.
Use `revoke_agent_access` with that id to cut off a key or client. For an OAuth client, its refresh tokens and
consent are removed, so it cannot renew access. Confirm with the person before revoking. `list_audit_events`
shows who did what, including refusals, and needs an organization admin.

## Errors

Every error is `{ "error": { "code", "message", "hint?" } }`. Read the `hint`: it says what to change.

- `BAD_REQUEST`: fix the input; the message names the field.
- `UNAUTHORIZED`: no valid credential. Send an API key or OAuth access token.
- `FORBIDDEN`: the credential lacks the permission. The hint names the scope or key permission.
  Or the plan doesn't include it (for example a third workspace agent on Free): the hint names the
  plan that does. Tell the person; only an owner or admin changes the plan, in the web app.
- `NOT_FOUND`: also returned for another organization's ids. Don't retry the same id.
- `CONFLICT`: the Idempotency-Key is in use or was used with another body. Use a new key only for a new action.
- `RATE_LIMITED`: back off for `Retry-After` seconds, then retry.
- `SESSION_NOT_FRESH`: a person's session signed in over an hour ago and the action is sensitive (create_api_key, decide_approval, undo_approval, reset_member_two_factor, revoke_agent_access, revoke_scim_token). The person must sign in again; API keys and OAuth tokens are not affected.
- `INTERNAL`: retry once, then report it with the `x-request-id` response header.
