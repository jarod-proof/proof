import { type ApiInfo, inputSchema, outputSchema } from "./openapi"
import { type AnyOperation, formatPermissions } from "./operation"

export interface DocsLinks {
  /** Extra links for the llms.txt "Docs" section, e.g. a quickstart or the agent skill. */
  docs?: { title: string; url: string; note?: string }[]
}

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``

/** Operations that need no credential: the ones declared `auth: "none"`. */
const isPublic = (op: AnyOperation) => op.auth === "none"
const publicNames = (ops: readonly AnyOperation[]) => ops.filter(isPublic).map((op) => op.name)
/** Customers' agents read these documents; the operator's own operations are not for them. */
const forCustomers = (ops: readonly AnyOperation[]) =>
  ops.filter((op) => op.audience !== "operator")

/** The device grant's scope and the resource it is bound to (kept in step with device-flow.test.ts). */
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/** The name agents and clients know the server by: the title as a slug ("Acme API" -> "acme-api"). */
export function serverName(info: ApiInfo): string {
  return (
    info.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "api"
  )
}

/** An example call. Anonymous operations (no credential) get no auth header. */
function curl(op: AnyOperation, baseURL: string, anonymous: boolean): string {
  const input = (op.examples?.[0]?.input ?? {}) as Record<string, unknown>
  const rest: Record<string, unknown> = { ...input }
  // Whole parameter names only: `:id` must not match the start of `:idx`.
  const path = op.path.replace(/:([A-Za-z0-9_]+)/g, (param, k: string) => {
    if (!(k in input)) return param
    delete rest[k]
    return encodeURIComponent(String(input[k]))
  })
  const lines = [`curl -X ${op.method} "${baseURL}${path}`]
  if (op.method === "GET" || op.method === "DELETE") {
    const qs = new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, String(v)])).toString()
    lines[0] += qs ? `?${qs}"` : `"`
  } else lines[0] += `"`
  if (!anonymous) lines.push(`  -H "x-api-key: $API_KEY"`)
  if (op.method !== "GET" && op.method !== "DELETE") {
    lines.push(`  -H "content-type: application/json"`, `  -d '${JSON.stringify(rest)}'`)
  }
  return lines.join(" \\\n")
}

function intro(info: ApiInfo, unauthenticated: readonly string[]): string[] {
  const open =
    unauthenticated.length > 0
      ? ` Operations marked "no credential" need none (${unauthenticated
          .map((n) => `\`${n}\``)
          .join(", ")}); the rest do.`
      : ""
  return [
    `# ${info.title}`,
    "",
    `> ${info.description}`,
    "",
    "Authenticate with an organization API key (`x-api-key: sk_...` or `Authorization: Bearer sk_...`) " +
      "or an OAuth access token. Every request acts in one organization, with the key's permissions, " +
      "or the user's role narrowed by the token's scopes." +
      open +
      ' Errors are JSON: `{ "error": { "code", "message", "hint?" } }`.',
    "",
  ]
}

/**
 * Install snippets for each client, built from the server's base URL and name. Each one connects
 * over Streamable HTTP; the client finds the OAuth sign-in from the 401 at /mcp, so no key is pasted.
 */
export function installSnippets(info: ApiInfo, unauthenticated: readonly string[] = []): string[] {
  const name = serverName(info)
  const mcp = `${info.baseURL}/mcp`
  const remote = { url: mcp }
  const cursorConfig = btoa(JSON.stringify(remote))
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(cursorConfig)}`
  const signupRequest = `curl -s -X POST "${info.baseURL}/v1/signup" \\\n  -H "content-type: application/json" \\\n  -d '{"email":"person@example.com","name":"Ada"}'`
  return [
    "## Install",
    "",
    `The MCP server is \`${mcp}\` (Streamable HTTP). Pick the client:`,
    "",
    "### Claude Code",
    "",
    fence("sh", `claude mcp add --transport http ${name} ${mcp}`),
    "Then run `/mcp` in Claude Code and finish the sign-in in the browser.",
    "",
    "### Cursor",
    "",
    `[Add to Cursor](${cursorLink}), or put this in \`.cursor/mcp.json\`:`,
    "",
    fence("json", JSON.stringify({ mcpServers: { [name]: remote } }, null, 2)),
    "",
    "### VS Code",
    "",
    fence("sh", `code --add-mcp '${JSON.stringify({ name, type: "http", url: mcp })}'`),
    "Or put this in `.vscode/mcp.json`:",
    "",
    fence("json", JSON.stringify({ servers: { [name]: { type: "http", url: mcp } } }, null, 2)),
    "",
    "### Claude on claude.ai",
    "",
    "Settings → Connectors (Customize → Connectors on a personal plan) → Add custom connector, then paste",
    `\`${mcp}\` as the MCP server URL and click Add. Choose "Sign in now" when it asks how people connect,`,
    "so each person signs in with their own account.",
    "",
    "### Gemini CLI",
    "",
    fence("sh", `gemini mcp add --transport http ${name} ${mcp}`),
    "Or put this in `~/.gemini/settings.json`:",
    "",
    fence("json", JSON.stringify({ mcpServers: { [name]: { httpUrl: mcp } } }, null, 2)),
    "",
    "### Codex CLI",
    "",
    "Add this to `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):",
    "",
    fence("toml", `[mcp_servers.${name}]\nurl = "${mcp}"`),
    "Then sign in once, in the browser: `codex mcp login " + name + "`.",
    "",
    "### CLI",
    "",
    "The `proof` command signs in with the device grant (below) and calls any operation from a terminal:",
    "",
    fence(
      "sh",
      `npx @proof/cli login --base-url ${info.baseURL}\nnpx @proof/cli whoami\nnpx @proof/cli ops\nnpx @proof/cli call <operation> --json '{}'`,
    ),
    "",
    "### Any other MCP client",
    "",
    fence("json", JSON.stringify({ mcpServers: { [name]: remote } }, null, 2)),
    "",
    "### Headless or CI: device grant",
    "",
    "No browser on the machine? Use the OAuth device grant (RFC 8628). The person approves the code in",
    "any browser; the token is bound to the organization they have active.",
    "",
    "1. Register a public client once (`token_endpoint_auth_method` none; the device grant and refresh are",
    "   not implied, so list them):",
    "",
    fence(
      "sh",
      `curl -s -X POST "${info.baseURL}/api/auth/oauth2/register" \\\n  -H "content-type: application/json" \\\n  -d '${JSON.stringify({ client_name: `${name}-cli`, token_endpoint_auth_method: "none", grant_types: [DEVICE_GRANT, "refresh_token"] })}'`,
    ),
    "",
    "2. Ask for a device code. Show the person `verification_uri` and `user_code`:",
    "",
    fence(
      "sh",
      `curl -s -X POST "${info.baseURL}/api/auth/device/code" \\\n  -H "content-type: application/json" \\\n  -d '${JSON.stringify({ client_id: "CLIENT_ID", scope: "read write offline_access", resource: mcp })}'`,
    ),
    "",
    "Keep `offline_access` in the scope. It makes the server issue a refresh token; without it the",
    "client cannot renew access, and the refresh token is revoked if the approving web session signs out.",
    "Add `admin` to the scope only if the agent must create API keys or manage members and agents.",
    "",
    "3. Poll `/api/auth/oauth2/token` every `interval` seconds until it returns `access_token`. On",
    "   `authorization_pending` keep polling; on `slow_down` wait longer:",
    "",
    fence(
      "sh",
      `curl -s -X POST "${info.baseURL}/api/auth/oauth2/token" \\\n  -d grant_type=${DEVICE_GRANT} -d device_code=DEVICE_CODE -d client_id=CLIENT_ID`,
    ),
    "",
    "Send `Authorization: Bearer <access_token>` to `/mcp` or `/v1/*`. Refresh with",
    "`grant_type=refresh_token` and the `refresh_token` from the same response.",
    "",
    ...(unauthenticated.includes("signup")
      ? [
          "### Agent self-signup (no credential)",
          "",
          "An agent with no account yet can create one. The response carries an API key that works at a",
          "low daily limit (`limits.requestsPerDay`) until the person opens the claim email sent to the",
          "address they gave. Ask them to use that address; don't guess one.",
          "",
          fence("sh", signupRequest),
          "Returns `{ organizationId, apiKey, claimUrlSentTo, limits }`.",
          "",
        ]
      : []),
  ]
}

/** llms.txt (https://llmstxt.org): an index agents read first. Serve it at /llms.txt. */
export function llmsTxt(all: readonly AnyOperation[], info: ApiInfo, links: DocsLinks = {}) {
  const ops = forCustomers(all)
  const unauthenticated = publicNames(ops)
  const lines = [
    ...intro(info, unauthenticated),
    "## Docs",
    "",
    `- [Full reference](${info.baseURL}/llms-full.txt): every operation with schemas and examples`,
    `- [OpenAPI](${info.baseURL}/openapi.json): OpenAPI 3.1 spec`,
    `- [MCP server](${info.baseURL}/mcp): Streamable HTTP; same operations as tools, OAuth sign-in`,
    `- [MCP registry record](${info.baseURL}/.well-known/mcp/server.json): server.json for registries`,
    ...(links.docs ?? []).map((d) => `- [${d.title}](${d.url})${d.note ? `: ${d.note}` : ""}`),
    "",
    ...installSnippets(info, unauthenticated),
    "## Operations",
    "",
    ...ops.map(
      (op) =>
        `- \`${op.method} ${op.path}\` (\`${op.name}\`${isPublic(op) ? ", no credential" : op.auth === "person" ? ", web app only" : ""}): ${op.summary}`,
    ),
    "",
  ]
  return lines.join("\n")
}

/** Every operation in full, as one Markdown file. Serve it at /llms-full.txt. */
export function llmsFullTxt(all: readonly AnyOperation[], info: ApiInfo, links: DocsLinks = {}) {
  const ops = forCustomers(all)
  const unauthenticated = publicNames(ops)
  const docs = (links.docs ?? []).map(
    (d) => `- [${d.title}](${d.url})${d.note ? `: ${d.note}` : ""}`,
  )
  const sections = ops.map((op) => {
    const example = op.examples?.[0]
    const open = isPublic(op)
    return [
      `## ${op.name}`,
      "",
      `\`${op.method} ${op.path}\`. ${op.summary}`,
      "",
      op.description,
      "",
      open
        ? "Credential: none. Anyone may call this."
        : op.auth === "person"
          ? "Credential: a person's web app session only. API keys and OAuth tokens are refused."
          : `Permissions: ${formatPermissions(op.permissions) || "none (any authenticated caller)"}`,
      "",
      "Input:",
      "",
      fence("json", JSON.stringify(inputSchema(op), null, 2)),
      "",
      "Output:",
      "",
      fence("json", JSON.stringify(outputSchema(op), null, 2)),
      "",
      ...(example
        ? [
            "Example:",
            "",
            fence("sh", curl(op, info.baseURL, open)),
            ...(example.output ? ["", fence("json", JSON.stringify(example.output, null, 2))] : []),
            ...(example.error ? ["", `Fails with \`${example.error}\`.`] : []),
            "",
          ]
        : []),
    ].join("\n")
  })
  return [
    ...intro(info, unauthenticated),
    ...(docs.length > 0 ? ["## Docs", "", ...docs, ""] : []),
    ...installSnippets(info, unauthenticated),
    ...sections,
  ].join("\n")
}
