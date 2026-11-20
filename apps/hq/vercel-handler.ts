// The bundler entry for the Vercel function (scripts/build-vercel.mjs). `index.ts` stays the
// readable source of the app; this file only adapts it to the (req, res) handler the Node runtime
// of a Build Output API function calls. `getRequestListener` turns Node's IncomingMessage and
// ServerResponse into a web Request and Response around `app.fetch`, so the lazy, memoized boot
// and the fixed 503 of a refused boot are exactly what index.ts defines.
import { getRequestListener } from "@hono/node-server"

import app from "./index"

export default getRequestListener(app.fetch)
