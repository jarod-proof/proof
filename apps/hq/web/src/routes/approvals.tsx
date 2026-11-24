import { createRoute } from "@tanstack/react-router"

import { Approvals } from "../containers/approvals"
import { appRoute } from "./app"

export const approvalsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/approvals",
  component: Approvals,
})
