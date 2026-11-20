// Type-level tests: checked by `pnpm typecheck`, not run by Vitest.
import { createLogger } from "@proof/logger"
import { observe } from "./index"

const logger = createLogger()

// A Next App Router-shaped handler keeps its route argument, and callers must supply it.
const GET = observe(
  (_req, { requestId }, route: { params: Promise<{ id: string }> }) =>
    new Response(`${requestId}:${typeof route.params}`),
  { logger },
)

void GET(new Request("https://localhost"), { params: Promise.resolve({ id: "1" }) })

// @ts-expect-error the route argument is required
void GET(new Request("https://localhost"))

// @ts-expect-error the route argument has the wrong shape
void GET(new Request("https://localhost"), { params: { id: "1" } })

// A handler with no extra arguments is called with just the request.
const plain = observe(() => new Response("ok"), { logger })
void plain(new Request("https://localhost"))

// @ts-expect-error no extra arguments expected
void plain(new Request("https://localhost"), {})
