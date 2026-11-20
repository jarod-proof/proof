// Operation names → HTTP method and path, read from the API's own openapi.json at runtime, so the
// CLI follows whatever the server exposes without a rebuild.
import { type Method, ProofError } from "@proof/sdk"

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const

interface SpecParameter {
  name: string
  in: string
  required?: boolean
}

interface SpecOperation {
  operationId?: string
  summary?: string
  parameters?: SpecParameter[]
  requestBody?: unknown
  security?: unknown[]
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown> & { parameters?: SpecParameter[] }>
}

export interface Operation {
  name: string
  method: Method
  path: string
  summary?: string
  parameters: SpecParameter[]
  hasBody: boolean
  /** Declared with `security: []`: the operation takes no credential (e.g. signup). */
  anonymous: boolean
}

export interface BuiltRequest {
  path: Record<string, string | number | boolean>
  query: Record<string, unknown>
  headers: Record<string, string>
  body?: unknown
}

/** Every operation in the document, in path order. Path-level parameters apply to each method. */
export function listOperations(doc: OpenApiDocument): Operation[] {
  const operations: Operation[] = []
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    for (const method of HTTP_METHODS) {
      const op = item[method] as SpecOperation | undefined
      if (!op?.operationId) continue
      const own = op.parameters ?? []
      const overridden = new Set(own.map((p) => `${p.in}:${p.name}`))
      operations.push({
        name: op.operationId,
        method: method.toUpperCase() as Method,
        path,
        summary: op.summary,
        parameters: [...shared.filter((p) => !overridden.has(`${p.in}:${p.name}`)), ...own],
        hasBody: op.requestBody !== undefined,
        anonymous: Array.isArray(op.security) && op.security.length === 0,
      })
    }
  }
  return operations
}

export function findOperation(doc: OpenApiDocument, name: string): Operation | undefined {
  return listOperations(doc).find((op) => op.name === name)
}

const usage = (message: string, hint?: string) =>
  new ProofError({ status: 0, code: "USAGE", message, hint })

/**
 * Splits one flat input object into what the request needs: path parameters fill the template,
 * declared query and header parameters go where they belong, and what is left is the JSON body
 * (or, for an operation with no body, extra query fields). This is the same merge the server does
 * for its own handlers, so `call` takes one object, as an agent would write it.
 */
export function buildRequest(op: Operation, input: Record<string, unknown>): BuiltRequest {
  const rest = { ...input }
  const built: BuiltRequest = { path: {}, query: {}, headers: {} }

  for (const param of op.parameters) {
    if (!(param.name in rest)) {
      if (param.in === "path" && param.required !== false) {
        throw usage(
          `Missing path parameter "${param.name}" for ${op.name}`,
          `Pass "${param.name}".`,
        )
      }
      continue
    }
    const value = rest[param.name]
    delete rest[param.name]
    if (value === undefined || value === null) continue
    if (param.in === "path") built.path[param.name] = scalar(param.name, value)
    else if (param.in === "query") built.query[param.name] = value
    else if (param.in === "header") built.headers[param.name] = String(scalar(param.name, value))
  }

  for (const name of op.path.match(/\{([^}]+)\}/g) ?? []) {
    const key = name.slice(1, -1)
    if (built.path[key] === undefined) {
      throw usage(`Missing path parameter "${key}" for ${op.name}`, `Pass "${key}".`)
    }
  }

  if (op.hasBody) {
    if (Object.keys(rest).length > 0) built.body = rest
  } else {
    Object.assign(built.query, rest)
  }
  return built
}

function scalar(name: string, value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  throw usage(`Parameter "${name}" must be a string, number or boolean`)
}
