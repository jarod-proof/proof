import { baseConfig } from "@proof/config/vitest.base"
import { getViteConfig } from "astro/config"
import { mergeConfig } from "vitest/config"

// getViteConfig resolves Astro's virtual modules (astro:env/client) for the components under test.
// Pages, layouts and content are .astro and .md, which coverage does not count; the components they
// render carry the tests.
export default getViteConfig(
  mergeConfig(baseConfig(undefined, ["src/test/**", "src/lib/**", "src/content.config.ts"]), {
    test: { environment: "jsdom" },
  }),
)
