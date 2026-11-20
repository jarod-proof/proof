#!/usr/bin/env node
// Generates a Storybook story for every shadcn example in packages/ui that has none.
//   cd packages/ui && npx shadcn@latest add <name>-example --overwrite   # then
//   pnpm stories
// shadcn writes examples into src/components/; this moves them into src/components/examples/
// first. Existing *.stories.tsx files are never overwritten.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const components = join(import.meta.dirname, "..", "packages", "ui", "src", "components")
const root = join(components, "examples")
const uiDir = join(components, "ui")

// Demos and their helpers land beside ui/ when shadcn installs them; they live in examples/.
const isDemo = (f) =>
  f.endsWith("-example.tsx") || f === "example.tsx" || f === "example-compat.tsx"
const moved = []
for (const file of readdirSync(components).filter(isDemo)) {
  const target = join(root, file)
  // A fresh copy of a helper we already keep (example.tsx) replaces nothing: ours is patched.
  if (!file.endsWith("-example.tsx") && existsSync(target)) rmSync(join(components, file))
  else renameSync(join(components, file), target)
  moved.push(file)
}

const pascal = (kebab) =>
  kebab
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("")

const title = (kebab) =>
  kebab
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")

/** Names exported by a module, from `export function X`, `export const X` and `export { A, B }`. */
function exportsOf(source) {
  const names = new Set()
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)) {
    names.add(m[1])
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
      if (name) names.add(name)
    }
  }
  return [...names]
}

// Examples that can't work in a framework-free template (they need the Vercel AI SDK and files from
// shadcn's own website). Their components still exist; they just get no example story.
const SKIP = new Set(["message", "message-scroller"])

// shadcn's demos assume Next.js; point those imports at plain elements.
const IMPORT_SWAPS = [
  [
    'import Image from "next/image"',
    'import { Image } from "@proof/ui/components/examples/example-compat"',
  ],
  [
    'import Link from "next/link"',
    'import { Link } from "@proof/ui/components/examples/example-compat"',
  ],
  // shadcn imports its wrapper from the components alias; ours lives in examples/.
  ['"@proof/ui/components/example"', '"@proof/ui/components/examples/example"'],
]

// Exact-string fixes for strict-mode errors in upstream demos (noUncheckedIndexedAccess).
// Each is skipped silently when the upstream text is no longer there.
const PATCHES = [
  ["chart-example.tsx", "radialChartData[0].visitors", "radialChartData[0]?.visitors"],
  ["field-example.tsx", "temperature[0].toFixed(1)", "temperature[0]?.toFixed(1)"],
  ["field-example.tsx", "temperature[1].toFixed(1)", "temperature[1]?.toFixed(1)"],
  ["toggle-group-example.tsx", "setFontWeight(value[0])", "setFontWeight(value[0] ?? fontWeight)"],
]

function sanitize(file) {
  const path = join(root, file)
  let text = readFileSync(path, "utf8")
  const before = text
  for (const [from, to] of IMPORT_SWAPS) text = text.replaceAll(from, to)
  for (const [f, from, to] of PATCHES) if (f === file) text = text.replaceAll(from, to)
  if (text !== before) writeFileSync(path, text)
}

let written = 0
const skipped = []

for (const file of readdirSync(root).filter((f) => f.endsWith("-example.tsx"))) {
  const name = file.replace(/-example\.tsx$/, "")
  if (SKIP.has(name)) {
    skipped.push(`${name} (needs the AI SDK; delete ${file} if present)`)
    continue
  }
  sanitize(file)
  const storyPath = join(uiDir, `${name}.stories.tsx`)
  const uiPath = join(uiDir, `${name}.tsx`)
  if (existsSync(storyPath)) continue
  if (!existsSync(uiPath)) {
    skipped.push(`${name} (no ui/${name}.tsx)`)
    continue
  }

  // shadcn examples use `export default function XExample()`.
  const example = readFileSync(join(root, file), "utf8").match(
    /export\s+default\s+function\s+(\w+)/,
  )?.[1]
  const uiExports = exportsOf(readFileSync(uiPath, "utf8"))
  // Prefer the component named after the file; otherwise the first export that is a component.
  const component =
    uiExports.find((e) => e === pascal(name)) ??
    uiExports.find((e) => /^[A-Z]/.test(e) && !e.endsWith("Variants")) ??
    null
  if (!example || !component) {
    skipped.push(`${name} (example=${example}, component=${component})`)
    continue
  }

  writeFileSync(
    storyPath,
    `import type { Meta, StoryObj } from "@storybook/react-vite"
import ${example} from "../examples/${name}-example"
import { ${component} } from "./${name}"

const meta = {
  title: "ui/${title(name)}",
  component: ${component},
  parameters: { layout: "padded" },
} satisfies Meta<typeof ${component}>

export default meta

export const Examples: StoryObj = {
  render: () => <${example} />,
}
`,
  )
  written++
}

if (moved.length) console.log(`Moved into examples/: ${moved.join(", ")}`)
console.log(`Wrote ${written} stories.`)
if (skipped.length) console.log(`Skipped:\n  ${skipped.join("\n  ")}`)
