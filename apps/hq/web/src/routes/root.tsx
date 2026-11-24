import type { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router"

import type { HqClient } from "../api/client"

export interface RouterContext {
  queryClient: QueryClient
  client: HqClient
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet })
