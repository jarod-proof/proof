import type { E2EConfig } from "e2e"
import { web } from "@e2e-dev/web"

import base from "./e2e.config"

// The shipped path: the built web app served by apps/api (WEB_DIST_DIR) with its real CSP, already
// running at E2E_BASE_URL (default http://localhost:3000). Nothing is started here. Start it with
// `pnpm --filter @proof/app build`, then apps/api with WEB_DIST_DIR=apps/app/dist and DEV_MAIL_SINK=true.
// Run: `pnpm exec e2e run --config e2e.dist.config.ts [files]`.
const app = { url: process.env.E2E_BASE_URL ?? "http://localhost:3000" }

export default {
  ...base,
  targets: [
    { name: "desktop", engine: web(), app },
    { name: "phone", engine: web({ viewport: { width: 390, height: 844 } }), app },
  ],
} satisfies E2EConfig
