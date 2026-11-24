import { appRoute, notFoundRoute } from "./routes/app"
import { approvalsRoute } from "./routes/approvals"
import { digestRoute } from "./routes/digest"
import { indexRoute } from "./routes/index"
import { rootRoute } from "./routes/root"
import { runnerRoute } from "./routes/runner"
import { signInRoute } from "./routes/sign-in"

export const routeTree = rootRoute.addChildren([
  signInRoute,
  appRoute.addChildren([indexRoute, digestRoute, approvalsRoute, runnerRoute, notFoundRoute]),
])
