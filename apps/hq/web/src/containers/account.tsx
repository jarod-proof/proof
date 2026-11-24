import { useMutation, useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"

import { hqKeys } from "../api/query-keys"
import { AccountMenu } from "../components/account-menu"
import { errorMessage } from "../components/states"
import { useHq } from "../lib/use-hq"

/** Who is signed in, for display only (null while loading or when the lookup failed). */
export function useSessionEmail(options: { enabled?: boolean } = {}): string | null {
  const { client } = useHq()
  const session = useQuery({
    queryKey: hqKeys.session(),
    queryFn: () => client.session(),
    enabled: options.enabled ?? true,
  })
  return session.data?.email ?? null
}

/**
 * Sign out: one POST, then the sign-in page and an empty cache. The cache is cleared after the
 * navigation so nothing mounted refetches into a 401 on the way out.
 */
export function useSignOut(): { signOut(): void; pending: boolean; error: string | null } {
  const { client, queryClient } = useHq()
  const router = useRouter()
  const mutation = useMutation({
    mutationFn: () => client.signOut(),
    onSuccess: async () => {
      await router.navigate({ to: "/sign-in", replace: true })
      queryClient.clear()
    },
  })
  return {
    signOut: () => {
      if (!mutation.isPending && !mutation.isSuccess) mutation.mutate()
    },
    pending: mutation.isPending || mutation.isSuccess,
    error: mutation.error ? errorMessage(mutation.error) : null,
  }
}

/** The sidebar's account block. */
export function Account() {
  const email = useSessionEmail()
  const { signOut, pending, error } = useSignOut()
  return <AccountMenu email={email} onSignOut={signOut} pending={pending} error={error} />
}
