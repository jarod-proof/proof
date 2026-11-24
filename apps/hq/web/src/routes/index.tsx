import { createRoute, redirect } from "@tanstack/react-router"

import { appRoute } from "./app"

export const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/digest", replace: true })
  },
})
