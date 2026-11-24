import { z } from "zod"

// The CSP has no 'unsafe-eval': zod's JIT compiles validators with `new Function`, which it forbids.
z.config({ jitless: true })
