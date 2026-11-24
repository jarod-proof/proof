import { createRoute } from "@tanstack/react-router"

import { Runner } from "../containers/runner"
import { appRoute } from "./app"

export const runnerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/runner",
  component: Runner,
})
