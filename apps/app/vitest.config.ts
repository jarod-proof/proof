import { baseConfig } from "@proof/config/vitest.base"
import { mergeConfig } from "vitest/config"

// Route files, the router and the generated route tree are wiring: each one only passes params and
// search to a page, and the pages carry the tests. The test helpers are not product code either, and
// the devtools only load in dev.
export default mergeConfig(
  baseConfig(undefined, [
    "src/routes/**",
    "src/router.tsx",
    "src/routeTree.gen.ts",
    "src/test/**",
    "src/devtools.tsx",
  ]),
  {
    test: {
      environment: "jsdom",
      setupFiles: ["src/test/setup.ts"],
    },
  },
)
