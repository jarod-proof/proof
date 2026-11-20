// What a deployed hq may and may not do, decided from NODE_ENV the way packages/env treats its other
// development-only switches (DEV_MAIL_SINK, AUTH_RATE_LIMIT=off): only an explicit `development` or
// `test` is a local stack; production, or NODE_ENV unset, is deployed. Failing open would let a
// forgotten variable turn the guards off.

/** Whether this is anything but a local development or test stack. */
export function isProductionLike(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "development" && nodeEnv !== "test"
}

/**
 * What is wrong with an environment about to be deployed (`pnpm hq:predeploy` reads the target's).
 * Stricter than hq's own boot, which lets an unset NODE_ENV through as deployed: this one wants it
 * to say `production`, because a NODE_ENV of development or test set by mistake in production
 * would reopen sign-up and email founders. Empty means fit to deploy.
 */
export function predeployProblems(config: {
  nodeEnv: string | undefined
  allowSignUp: boolean
  founders: readonly { who: { email: string } | { userId: string } }[]
}): string[] {
  const problems: string[] = []
  if (config.nodeEnv !== "production") {
    problems.push(
      `NODE_ENV is ${config.nodeEnv === undefined ? "unset" : `"${config.nodeEnv}"`}, not "production": ` +
        "a development or test hq opens sign-up and takes founders by email.",
    )
  }
  if (config.allowSignUp) problems.push("HQ_ALLOW_SIGNUP is on: public sign-up must be off.")
  const byEmail = config.founders.filter((f) => "email" in f.who).length
  if (byEmail > 0) {
    problems.push(
      `HQ_FOUNDERS has ${byEmail} email= ${byEmail === 1 ? "entry" : "entries"}: a deployed hq ` +
        "ignores them and would drop those founders. Run create-founder and list id:<user id>.",
    )
  }
  return problems
}

/**
 * Public sign-up stays off in a deployed hq: every founder account is made on the server by
 * `create-founder`, so no stranger can register an address and wait for its owner to verify it.
 * Throws with the reason; hq's boot and `create-founder` both call it.
 */
export function assertSignUpClosedWhenDeployed(config: {
  nodeEnv: string | undefined
  allowSignUp: boolean
}): void {
  if (config.allowSignUp && isProductionLike(config.nodeEnv)) {
    throw new Error(
      "HQ_ALLOW_SIGNUP is on in a deployed hq (NODE_ENV is not development or test). " +
        "Public sign-up must stay off there: unset HQ_ALLOW_SIGNUP and make founders with create-founder.",
    )
  }
}
