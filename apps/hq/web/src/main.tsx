import "./zod-config"
import "./app.css"

import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { createRoot } from "react-dom/client"

import { createHqClient } from "./api/client"
import { createQueryClient } from "./api/query-client"
import { createAppRouter } from "./router"

const queryClient = createQueryClient()
const router = createAppRouter({ queryClient, client: createHqClient() })

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}
