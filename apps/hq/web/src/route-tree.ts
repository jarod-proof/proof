import { appRoute, notFoundRoute } from "./routes/app"
import { approvalsRoute } from "./routes/approvals"
import { digestRoute } from "./routes/digest"
import { indexRoute } from "./routes/index"
import { rootRoute } from "./routes/root"
import { runnerRoute } from "./routes/runner"
import { signInRoute } from "./routes/sign-in"
import { workRoute } from "./routes/work"
import { workItemRoute } from "./routes/work-item"

export const routeTree = rootRoute.addChildren([
  signInRoute,
  // The splat notFoundRoute stays LAST: it matches anything the routes before it do not.
  appRoute.addChildren([
    indexRoute,
    digestRoute,
    workRoute,
    workItemRoute,
    approvalsRoute,
    runnerRoute,
    notFoundRoute,
  ]),
])
