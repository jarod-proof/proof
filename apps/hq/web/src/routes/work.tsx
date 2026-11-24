import { createRoute } from "@tanstack/react-router"

import { Work } from "../containers/work"
import { appRoute } from "./app"

export const workRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/work",
  component: Work,
})
