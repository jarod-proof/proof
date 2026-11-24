import "./zod-config"

import { createRouter, type RouterHistory } from "@tanstack/react-router"

import type { RouterContext } from "./routes/root"
import { routeTree } from "./route-tree"

/** The app's router. Public URLs live under /app. `history` is for tests (memory history). */
export function createAppRouter(context: RouterContext, options: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    basepath: "/app",
    context,
    defaultPreload: "intent",
    ...(options.history ? { history: options.history } : {}),
  })
}
export type AppRouter = ReturnType<typeof createAppRouter>
export type { RouterContext }
