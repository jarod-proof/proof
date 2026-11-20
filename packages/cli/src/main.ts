import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { createClient, ProofError } from "@proof/sdk"
import {
  DEFAULT_SCOPE,
  withOfflineAccess,
  type Deps,
  needsRefresh,
  pollForTokens,
  refreshTokens,
  registerClient,
  requestDeviceCode,
  resourceOf,
  revokeRefreshToken,
  send,
} from "./auth"
import { type Credentials, credentialsPath, loadCredentials, saveCredentials } from "./config"
import { buildRequest, findOperation, listOperations, type OpenApiDocument } from "./spec"

// The product's public API origin (PRODUCT.publicURL in apps/api/src/product.ts), used when nothing
// else names one. Local dev sets PROOF_URL or --base-url.
export const DEFAULT_BASE_URL = "https://api.example.com"

export interface Io {
  stdout: (text: string) => void
  stderr: (text: string) => void
  readStdin: () => Promise<string>
}

export interface Environment {
  env: Record<string, string | undefined>
  /** Where credentials are stored. Defaults to credentialsPath(env). */
  credentialsFile?: string
  deps: Deps
  io: Io
}

const HELP = `proof: command-line client for the Proof API

Usage:
  proof login [--base-url URL] [--scope "read write"]   sign in (offline_access is always added)
  proof logout [--base-url URL]                          forget the saved session
  proof whoami                                           show the credential in use
  proof ops                                              list the API's operations
  proof call <operation> [--json '{...}' | --input FILE]  run one operation (use - for stdin)
                           [--idempotency-key KEY]

Options:
  --base-url URL   API origin (default: PROOF_URL, the last login, or ${DEFAULT_BASE_URL})

Environment:
  PROOF_URL       API origin
  PROOF_API_KEY   use this API key instead of a saved login
  PROOF_CONFIG_DIR  where credentials.json is kept (default ~/.config/proof)

Output is JSON on stdout. Errors are JSON on stderr, as {"status", "error": {code, message, hint}},
and the exit code is 1 (2 for a usage mistake).
`

const usage = (message: string, hint?: string) =>
  new ProofError({ status: 0, code: "USAGE", message, hint })

/** Runs one CLI invocation and returns its exit code. Never throws. */
export async function main(argv: string[], context: Environment): Promise<number> {
  const { io } = context
  try {
    const parsed = parse(argv)
    if (parsed.help || parsed.command === undefined) {
      io.stdout(HELP)
      return 0
    }
    const output = await dispatch(parsed.command, parsed.positionals, parsed.values, context)
    io.stdout(`${JSON.stringify(output, null, 2)}\n`)
    return 0
  } catch (error) {
    const err = toProofError(error)
    io.stderr(`${JSON.stringify(err.toJSON(), null, 2)}\n`)
    return err.code === "USAGE" ? 2 : 1
  }
}

function toProofError(error: unknown): ProofError {
  if (error instanceof ProofError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ProofError({ status: 0, code: "INTERNAL", message, cause: error })
}

interface Flags {
  "base-url"?: string
  json?: string
  input?: string
  "idempotency-key"?: string
  scope?: string
  help?: boolean
}

function parseFlags(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "base-url": { type: "string" },
        json: { type: "string" },
        input: { type: "string" },
        "idempotency-key": { type: "string" },
        scope: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (error) {
    throw usage(error instanceof Error ? error.message : "Invalid arguments", "Run proof --help.")
  }
}

function parse(argv: string[]) {
  const parsed = parseFlags(argv)
  const [command, ...positionals] = parsed.positionals
  const values = parsed.values as Flags
  return {
    command,
    // Index 0 is the command, so positionals[1] is the operation name for `call`.
    positionals: [command, ...positionals],
    values,
    help: values.help === true,
  }
}

async function dispatch(
  command: string,
  positionals: (string | undefined)[],
  flags: Flags,
  context: Environment,
): Promise<unknown> {
  switch (command) {
    case "login":
      return login(flags, context)
    case "logout":
      return logout(flags, context)
    case "whoami":
      return whoami(flags, context)
    case "ops":
      return ops(flags, context)
    case "call":
      return call(positionals[1], flags, context)
    default:
      throw usage(`Unknown command "${command}"`, "Run proof --help.")
  }
}

/** The origin to talk to: --base-url, then PROOF_URL, then the last login, then the default. */
export function resolveBaseUrl(flags: Flags, env: Environment["env"], creds: Credentials): string {
  // An empty PROOF_URL counts as unset.
  const raw = flags["base-url"] ?? (env.PROOF_URL || undefined) ?? creds.current ?? DEFAULT_BASE_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw usage(`Not a URL: ${raw}`, "Pass an absolute URL such as https://api.example.com.")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw usage(`Unsupported URL scheme in ${raw}`, "Use http or https.")
  }
  // Tokens and refresh tokens travel to this origin, so plain http is for this machine only.
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw usage(
      `Refusing plain http to ${url.host}`,
      "Use https. Plain http is only allowed for localhost, 127.0.0.1 and [::1].",
    )
  }
  return url.origin
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  )
}

async function store(context: Environment) {
  const file = context.credentialsFile ?? credentialsPath(context.env)
  return { file, creds: await loadCredentials(file) }
}

async function login(flags: Flags, context: Environment) {
  const { deps, io, env } = context
  const { file, creds } = await store(context)
  const base = resolveBaseUrl(flags, env, creds)
  const scope = withOfflineAccess(flags.scope ?? DEFAULT_SCOPE)

  let clientId = creds.profiles[base]?.clientId
  if (clientId === undefined) {
    clientId = await registerClient(base, deps)
    // Keep the client even if the sign-in is abandoned, so the next login reuses it.
    creds.profiles[base] = { clientId }
    await saveCredentials(file, creds)
  }

  const device = await requestDeviceCode(base, clientId, scope, deps)
  io.stderr(
    `To sign in, open ${device.verificationUriComplete ?? device.verificationUri}\n` +
      `and confirm the code ${device.userCode}. Waiting for approval...\n`,
  )
  const tokens = await pollForTokens(base, clientId, device, deps)

  creds.profiles[base] = {
    clientId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
  }
  creds.current = base
  await saveCredentials(file, creds)
  return {
    loggedIn: true,
    baseUrl: base,
    resource: resourceOf(base),
    scope: tokens.scope ?? scope,
    expiresAt: new Date(tokens.expiresAt).toISOString(),
  }
}

async function logout(flags: Flags, context: Environment) {
  const { file, creds } = await store(context)
  const base = resolveBaseUrl(flags, context.env, creds)
  const profile = creds.profiles[base]
  if (!profile) return { loggedOut: false, baseUrl: base }
  try {
    await revokeRefreshToken(base, profile, context.deps)
  } catch {
    // The local session is forgotten either way; a server we cannot reach keeps its token until it expires.
  }
  delete creds.profiles[base]
  if (creds.current === base) creds.current = undefined
  await saveCredentials(file, creds)
  return { loggedOut: true, baseUrl: base }
}

async function whoami(flags: Flags, context: Environment) {
  const { client } = await apiAccess(flags, context)
  const { data } = await client.GET("/v1/whoami")
  return data ?? null
}

async function ops(flags: Flags, context: Environment) {
  // The contract is public, so listing operations needs no credential.
  const base = await originOf(flags, context)
  const doc = await fetchSpec(base, context)
  return listOperations(doc).map(({ name, method, path, summary }) => ({
    name,
    method,
    path,
    summary,
  }))
}

async function call(name: string | undefined, flags: Flags, context: Environment) {
  if (name === undefined) {
    throw usage("call needs an operation name", "Run proof ops to list them.")
  }
  const base = await originOf(flags, context)
  const doc = await fetchSpec(base, context)
  const op = findOperation(doc, name)
  if (!op) throw usage(`Unknown operation "${name}"`, "Run proof ops to list them.")
  const client = op.anonymous
    ? createClient({ baseURL: base, fetch: context.deps.fetch, sleep: context.deps.sleep })
    : (await apiAccess(flags, context)).client

  const request = buildRequest(op, await readInput(flags, context.io))
  if (flags["idempotency-key"] !== undefined) {
    request.headers["idempotency-key"] = flags["idempotency-key"]
  }
  return client.request(op.method, op.path, request)
}

/** The object `call` sends: --json, or --input FILE (or - for stdin). Empty when neither is given. */
async function readInput(flags: Flags, io: Io): Promise<Record<string, unknown>> {
  if (flags.json !== undefined && flags.input !== undefined) {
    throw usage("Pass --json or --input, not both")
  }
  let text: string | undefined = flags.json
  if (flags.input !== undefined) {
    text = flags.input === "-" ? await io.readStdin() : await readFile(flags.input, "utf8")
  }
  if (text === undefined || text.trim() === "") return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw usage("The input is not valid JSON")
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw usage("The input must be a JSON object")
  }
  return value as Record<string, unknown>
}

/** The origin a command talks to, without needing a credential. */
async function originOf(flags: Flags, context: Environment): Promise<string> {
  const { creds } = await store(context)
  return resolveBaseUrl(flags, context.env, creds)
}

async function fetchSpec(base: string, context: Environment): Promise<OpenApiDocument> {
  const response = await send(context.deps, new Request(`${base}/openapi.json`))
  if (!response.ok) {
    throw new ProofError({
      status: response.status,
      code: `HTTP_${response.status}`,
      message: `Could not read ${base}/openapi.json`,
      hint: "Check the base URL.",
    })
  }
  return (await response.json()) as OpenApiDocument
}

/**
 * The base URL and a client for the credential in use: PROOF_API_KEY when set, otherwise the
 * saved login, refreshed when its access token is near expiry.
 */
async function apiAccess(flags: Flags, context: Environment) {
  const { deps, env } = context
  const { file, creds } = await store(context)
  const base = resolveBaseUrl(flags, env, creds)
  const apiKey = env.PROOF_API_KEY
  if (apiKey) {
    return {
      base,
      client: createClient({ baseURL: base, apiKey, fetch: deps.fetch, sleep: deps.sleep }),
    }
  }
  if (!creds.profiles[base]) {
    throw new ProofError({
      status: 0,
      code: "NOT_LOGGED_IN",
      message: `No saved login for ${base}`,
      hint: "Run proof login, or set PROOF_API_KEY.",
    })
  }
  const accessToken = async () => {
    const latest = (await loadCredentials(file)).profiles[base]
    if (!latest) {
      throw new ProofError({
        status: 0,
        code: "NOT_LOGGED_IN",
        message: `No saved login for ${base}`,
        hint: "Run proof login.",
      })
    }
    if (!needsRefresh(latest, deps.now()) && latest.accessToken) return latest.accessToken
    const tokens = await refreshTokens(base, latest, deps)
    const after = await loadCredentials(file)
    after.profiles[base] = {
      ...latest,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    }
    await saveCredentials(file, after)
    return tokens.accessToken
  }
  return {
    base,
    client: createClient({ baseURL: base, accessToken, fetch: deps.fetch, sleep: deps.sleep }),
  }
}
