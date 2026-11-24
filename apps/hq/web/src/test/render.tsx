import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { type RenderResult, render } from "@testing-library/react"
import userEvent, { type UserEvent } from "@testing-library/user-event"
import type { ReactNode } from "react"

import { createHqClient } from "../api/client"
import { createQueryClient } from "../api/query-client"
import { type AppRouter, createAppRouter } from "../router"
import { createFakeHq, type FakeHq } from "./fake-hq"

export type { AppRouter }

export type RenderAppResult = RenderResult & {
  router: AppRouter
  queryClient: QueryClient
  hq: FakeHq
  user: UserEvent
}

/**
 * Render the app (its real route tree, basepath "/app", memory history) against a fake hq. `path`
 * is a public path (`/app/approvals`), default `/app/digest`; the default hq has a founder signed
 * in. Every request goes to `hq.fetch`.
 */
export async function renderApp(
  options: { path?: string; hq?: FakeHq; queryClient?: QueryClient } = {},
): Promise<RenderAppResult> {
  const hq = options.hq ?? createFakeHq()
  const queryClient = options.queryClient ?? createQueryClient()
  const client = createHqClient({ fetch: hq.fetch })
  const router = createAppRouter(
    { queryClient, client },
    { history: createMemoryHistory({ initialEntries: [options.path ?? "/app/digest"] }) },
  )
  await router.load()
  const user = userEvent.setup()
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return Object.assign(result, { router, queryClient, hq, user })
}

/**
 * Render one component inside a router (so `Link` works) at basepath "/app", for component tests
 * that do not need the app's routes.
 */
export async function renderInRouter(ui: ReactNode): Promise<RenderResult> {
  const rootRoute = createRootRouteWithContext<Record<string, never>>()({ component: Outlet })
  const page = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => ui })
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/app/"] }),
    basepath: "/app",
    context: {},
  })
  await router.load()
  return render(<RouterProvider router={router} />)
}
