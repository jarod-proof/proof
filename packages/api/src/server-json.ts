import type { ApiInfo } from "./openapi"

/** The schema the MCP registry validates server.json against (2025-12-11 revision). */
export const SERVER_JSON_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"

/** What only the publisher knows: the registry name and the one-line description. */
export interface RegistryMeta {
  /** Reverse-DNS name, `namespace/name`, e.g. `io.github.acme/api`. */
  name: string
  /** Up to 100 characters: what the server does, not how. */
  description: string
  /** The source repository, for registry users to inspect. Omitted when unknown. */
  repository?: { url: string; source: string }
}

/** Placeholder until a deployment names itself. The registry rejects this namespace on publish. */
export const DEFAULT_REGISTRY_META: RegistryMeta = {
  name: "io.github.jarod-proof/proof",
  description: "Proof API: projects, API keys, agent access and audit for people and agents.",
}

/**
 * The MCP registry's server.json for this API: one remote, Streamable HTTP at `${baseURL}/mcp`.
 * Served at /.well-known/mcp/server.json and committed as the root server.json for publishing.
 */
export function serverJson(info: ApiInfo, meta: RegistryMeta = DEFAULT_REGISTRY_META) {
  return {
    $schema: SERVER_JSON_SCHEMA,
    name: meta.name,
    title: info.title,
    description: meta.description,
    version: info.version,
    websiteUrl: `${info.baseURL}/llms.txt`,
    remotes: [{ type: "streamable-http" as const, url: `${info.baseURL}/mcp` }],
    ...(meta.repository && { repository: meta.repository }),
  }
}
