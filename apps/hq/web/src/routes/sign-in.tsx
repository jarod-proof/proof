import { createRoute } from "@tanstack/react-router"

import { SignIn } from "../containers/sign-in"
import { rootRoute } from "./root"

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === "string" ? { next: search.next } : {},
  component: SignIn,
})
