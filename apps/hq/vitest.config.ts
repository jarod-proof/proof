import { baseConfig } from "@proof/config/vitest.base"
import { mergeConfig } from "vitest/config"

// server.ts, env.ts and the two command-line scripts only wire env, the database and the Node listener; app.ts holds the logic.
export default mergeConfig(
  baseConfig(undefined, [
    "src/server.ts",
    "src/env.ts",
    "src/founder-principals.ts",
    "src/mint-agent-key.ts",
    "src/create-founder.ts",
    "src/predeploy.ts",
  ]),
  {
    test: {
      // Node tests share it: it guards on `typeof document`.
      setupFiles: ["web/src/test/setup.ts"],
      coverage: {
        // The ratchet counts the app's own code (web/src) beside hq's.
        include: ["src/**/*.{ts,tsx}", "web/src/**/*.{ts,tsx}"],
        // Entry points, route files and the harness are wiring or test support; web tests are
        // not source (the base config only excludes `src/**/*.test.*`).
        exclude: [
          "web/src/main.tsx",
          "web/src/router.tsx",
          "web/src/routes/**",
          "web/src/test/**",
          "web/src/**/*.test.*",
        ],
      },
    },
  },
)
