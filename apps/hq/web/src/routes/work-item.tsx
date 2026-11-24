import { createRoute, useParams } from "@tanstack/react-router"

import { Item } from "../containers/item"
import { appRoute } from "./app"

function WorkItemScreen() {
  // `strict: false`: the route cannot name itself in its own initializer, and the one param is a string.
  const { itemId = "" } = useParams({ strict: false })
  return <Item key={itemId} itemRef={itemId} />
}

/** One work item (`/work/FAC-12` or `/work/<uuid>`). */
export const workItemRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/work/$itemId",
  component: WorkItemScreen,
})
