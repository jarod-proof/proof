import { useRouter, useSearch } from "@tanstack/react-router"
import { useRef, useState } from "react"

import { errorMessage } from "../components/states"
import { safeNext } from "../lib/next-path"
import { useHq } from "../lib/use-hq"
import { SignInPage } from "../pages/sign-in-page"

/**
 * Signs in and goes to `?next` when it is a path inside the app. Deliberately no useMutation: a
 * mutation keeps its variables (the password) in the mutation cache. One request at a time, from
 * the form's submit only.
 */
export function SignIn() {
  const { client, queryClient } = useHq()
  const router = useRouter()
  const search = useSearch({ strict: false }) as { next?: unknown }
  const next = typeof search.next === "string" ? search.next : undefined
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  async function submit(input: { email: string; password: string }) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    try {
      await client.signIn(input)
    } catch (caught) {
      setError(errorMessage(caught, "sign-in"))
      setPending(false)
      busy.current = false
      return
    }
    // A new account: nothing cached for the last one (or for the signed-out probe) may be reused.
    queryClient.clear()
    router.history.push(`${router.basepath}${safeNext(next)}`)
  }

  return <SignInPage onSubmit={(input) => void submit(input)} pending={pending} error={error} />
}
