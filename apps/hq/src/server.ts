import { fileURLToPath } from "node:url"

import { serve } from "@hono/node-server"
import { createLogger } from "@proof/logger"

import { bootHq } from "./boot-hq"
import { createWebApp, routeToWeb } from "./web-static"

const logger = createLogger({ name: "hq" })

// The Node listener, for local development and the e2e stacks: the boot is `bootHq`, shared with
// the Vercel entry (../index.ts), and this file only listens. The e2e runner passes the port it
// picked as the first argument.
const { app, config } = await bootHq({ portArg: process.argv[2] })
// The built app (`pnpm build:web`) is served here too, so the e2e stacks and local runs have /app;
// without a build the listener is hq alone. On Vercel the static files come from the Build Output.
const web = createWebApp({ dir: fileURLToPath(new URL("../web/dist", import.meta.url)) })
serve({ fetch: routeToWeb(web, app), port: config.port }, (addr) =>
  logger.info({ port: addr.port }, "hq listening"),
)
