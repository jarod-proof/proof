import { availableParallelism } from "node:os"
import { configDefaults, defineConfig } from "vitest/config"

/**
 * Deterministic test suite configuration.
 *
 * @remarks
 * The suite never reaches a model, GitHub, Linear, Blob, or a sandbox: every
 * boundary is replaced with an in-process fake. The environment values below
 * exist only because several modules validate them at load time
 * (`FACTORY_REPO`); they name nothing real.
 *
 * `FACTORY_SANDBOX_EGRESS` is `open` here, which is not the default a
 * deployment gets. The lease, tool, and checkout suites assert the exact
 * firewall policy around every command, and they were written against open
 * egress, where a lease is `"*": []` plus its rules and ends in
 * `allow-all`. Open mode must keep producing exactly that, so those suites
 * run in it unchanged and double as its regression test. The default,
 * restricted mode is covered by `tests/github/egress.test.ts`, which clears
 * the variable and replays the same flows against the allowlist.
 */
export default defineConfig({
  test: {
    env: {
      FACTORY_INTAKE_TOKEN: "test-intake-token-0123456789abcdef",
      FACTORY_REPO: "acme/widgets",
      FACTORY_SANDBOX_EGRESS: "open",
    },
    environment: "node",
    // The lab base's limits (packages/config/vitest.base.ts): turbo runs every package's tests at
    // once, and these tests boot PGlite (real hq) alongside thousands of Foreman's.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 4)),
    include: ["tests/**/*.test.ts"],
    // The gh contract suite runs the real GitHub CLI's help and needs the gh version Foreman pins.
    // Unproven here until P2 with a pinned gh: `pnpm --filter @proof/agent test:cli` runs it.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.AGENT_CLI_TESTS === "1" ? [] : ["tests/github/gh-contract.test.ts"]),
    ],
    typecheck: {
      enabled: true,
      include: ["tests/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
})
