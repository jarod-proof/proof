import { createLogger } from "@proof/logger"

const logger = createLogger({ name: "agent" })

/** An error becomes its name and message: a stack and a cause can carry request details. */
const describe = (value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message } : value

/**
 * The agent's warnings, through the lab logger (pino, with its redaction) instead of `console`.
 *
 * @remarks
 * `warn` takes what `console.warn` took: a message, then details. It is a method on an object so a
 * test can spy on it, which is how Foreman's tests watch its warnings.
 */
export const log = {
  warn(message: unknown, ...details: unknown[]): void {
    logger.warn(
      { details: details.map(describe) },
      typeof message === "string" ? message : "warning",
    )
  },
}
