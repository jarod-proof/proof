import { createRoute, Outlet, useRouterState } from "@tanstack/react-router"

import { AppGate } from "../components/app-gate"
import { AppFrame } from "../components/app-frame"
import { EmptyState } from "../components/states"
import { Account } from "../containers/account"
import { ShellStatus } from "../containers/shell-status"
import { NAV_ITEMS } from "../lib/nav"
import { rootRoute } from "./root"

function AppLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const active = NAV_ITEMS.find(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  )
  return (
    <AppFrame sidebar={<ShellStatus activeKey={active?.key ?? null} account={<Account />} />}>
      <Outlet />
    </AppFrame>
  )
}

/** The pathless layout every screen sits in, behind the gate. */
export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: () => (
    <AppGate>
      <AppLayout />
    </AppGate>
  ),
})

/** Anything under /app that is no screen: a not-found state inside the frame. */
export const notFoundRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "$",
  component: () => (
    <EmptyState
      title="Page not found"
      description="There is no such screen. Pick one from the sidebar."
    />
  ),
})
