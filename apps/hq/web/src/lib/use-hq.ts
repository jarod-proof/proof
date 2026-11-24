import { useRouter } from "@tanstack/react-router"

import type { RouterContext } from "../routes/root"

/** The client and query client the router was built with (the only way a container reaches hq). */
export function useHq(): RouterContext {
  return useRouter().options.context as RouterContext
}
