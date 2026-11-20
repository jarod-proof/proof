import { baseConfig } from "@proof/config/vitest.base"

// src/components is vendored shadcn code (ui/) and its demos and shims (examples/; see AGENTS.md), and src/hooks is a
// vendored hook. They are smoke-tested (all.test.tsx, examples.test.tsx), not held to thresholds.
// src/dplus/pages is story-only scaffolding (the D+ boards rebuilt as Storybook pages).
export default baseConfig(undefined, ["src/components/**", "src/hooks/**", "src/dplus/pages/**"])
