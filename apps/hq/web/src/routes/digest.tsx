import { createRoute } from "@tanstack/react-router"

import { Digest } from "../containers/digest"
import { appRoute } from "./app"

export const digestRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/digest",
  component: Digest,
})
