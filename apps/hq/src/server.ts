import { serve } from "@hono/node-server"
import { createLogger } from "@proof/logger"

import { bootHq } from "./boot-hq"

const logger = createLogger({ name: "hq" })

// The Node listener, for local development and the e2e stacks: the boot is `bootHq`, shared with
// the Vercel entry (../index.ts), and this file only listens. The e2e runner passes the port it
// picked as the first argument.
const { app, config } = await bootHq({ portArg: process.argv[2] })
serve({ fetch: app.fetch, port: config.port }, (addr) =>
  logger.info({ port: addr.port }, "hq listening"),
)
