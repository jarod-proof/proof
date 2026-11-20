# Not yet

- Custom roles per org (`dynamicAccessControl`: resolve roles from the DB in `rolePermissions`, then
  rerun the parity test). The fixed capability roles (`approver`, `operator`, `billing`) cover the
  common gaps meanwhile; built-in roles must stay free of extra queries.
- Live Stripe: the plugin runs in test mode with env plans. The Billing page shows fixture data
  until it's configured.
- Admins can still read SSO provider config.
- E2e for passkeys (the e2e browser has no WebAuthn).
- Publishing: `.github/workflows/release.yml` publishes the CLI, the SDK and server.json from a
  version tag, once the setup in `docs/tooling.md` ("Releasing") is done. Not yet automated: the
  Claude connectors directory, Smithery, and `npx skills add` for `skills/proof` (which needs a
  public repository; the API serves the skill at `/skill.md` meanwhile). Each needs your namespace and
  a real URL. A `.well-known/agent-skills/index.json` once that convention settles.
- Deploy target: the Dockerfile and `scripts/release.mjs` only. No platform config.
- LLM onboarding eval: an agent starting from `llms.txt` alone, judged on its run. The deterministic
  HTTP journeys exist (`apps/api/src/onboarding.test.ts`: device grant from discovery, self-signup
  and claim, CLI login).
- Audit for FORBIDDEN and BAD_REQUEST attempts.
- Admin removal of a person leaves their personal organization (and its logo, API keys and
  entitlements rows) behind; better-auth's `removeUser` skips `deleteUser.beforeDelete`.
- Notifications: push delivery, per-person preferences and digests. In-app and email delivery
  exist, and agents can list a person's notifications (`docs/notifications.md`), but can't mark them
  read: that would drop the person's pending emails, so it needs its own design.
- An operation-level way to refuse API keys while allowing a person's session or OAuth token (unlike
  `auth: "person"`, which is session only), honoured by REST, MCP and OpenAPI, so keys don't see
  tools they can't call (today `list_notifications` refuses them in its handler).
- Verifying the Cursor and VS Code install snippets. Their shapes are inferred from docs. Windsurf
  and a Claude Desktop entry are left out of llms.txt until their docs give a URL-only remote setup.
- `llms.txt` on the marketing site (`apps/site`), and a sitemap. The site has no search, no
  newsletter backend (the form posts to `site.newsletterAction`) and no theme toggle.
- A periodic sweep for files orphaned before deletion swept them, or by a failed sweep.
- Uploads: presigned direct-to-bucket uploads for files bigger than an avatar. Resizing on upload.
  R2 buckets in an EU or US jurisdiction (an `R2_JURISDICTION` for the `<account>.eu.` endpoint),
  and Vercel Blob through OIDC alone (no read-write token). (`docs/storage.md`)
- Feature flags (`docs/feature-flags.md`): multi-variant flags and experiments (string and number
  values, sticky assignment, metrics per variant); targeting by attribute (plan, region) beyond
  organizations; metering OFREP calls; counting MCP tool failures and browser errors against the
  flag values they saw (today only REST 5xx are); clearing other API instances' rollout cache on a
  write (today they catch up within 5 seconds); a rollout history (the audit trail has who did what).
- Analytics (`docs/analytics.md`): signed-out page views (needs an anonymous id and consent),
  organization group properties, UI events beyond page views, per-person opt-out, a per-session rate
  limit on `POST /api/events`, and leaving impersonated sessions out of a person's events.
