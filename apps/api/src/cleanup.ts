// Scheduled maintenance: `pnpm --filter @proof/api-app cleanup`. Deletes expired signup attempts,
// idempotency keys and device approvals (see data/cleanup.ts). Run it from cron or the platform
// scheduler, once an hour is plenty. It exits 1 on error so the scheduler marks the run failed.
import { env } from "@proof/env"
import { createLogger } from "@proof/logger"

import { runCleanup } from "./data/cleanup"

const logger = createLogger({ name: "cleanup" })

runCleanup(env.DATABASE_URL).then(
  (counts) => {
    logger.info(counts, "cleanup finished")
    process.exit(0)
  },
  (error: unknown) => {
    logger.error({ err: error }, "cleanup failed")
    process.exit(1)
  },
)
