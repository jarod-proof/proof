import { baseConfig } from "@proof/config/vitest.base"

// server.ts, env.ts and the two command-line scripts only wire env, the database and the Node listener; app.ts holds the logic.
export default baseConfig(undefined, [
  "src/server.ts",
  "src/env.ts",
  "src/founder-principals.ts",
  "src/mint-agent-key.ts",
  "src/create-founder.ts",
  "src/predeploy.ts",
])
