import { baseConfig } from "@proof/config/vitest.base"

export default baseConfig({ lines: 80, functions: 80, branches: 70, statements: 80 }, [
  "src/bin.ts",
  "src/schema.gen.ts",
])
