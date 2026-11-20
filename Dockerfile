# syntax=docker/dockerfile:1
# Build from the repo root: `docker build .`. The API runs from source with tsx (apps/api), so the
# runtime image keeps node_modules; bundling is out of scope. Migrations run as a separate release
# step: `node scripts/release.mjs` (see docker-compose.yml), not on container start.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS base
# pnpm at the packageManager version, from corepack (bundled with Node 24).
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate
ENV TURBO_TELEMETRY_DISABLED=1 CI=1
WORKDIR /app

# Prune the monorepo to the API and the web app. `out/json` holds only manifests and the pruned
# lockfile, so the dependency layer is reused until those change; `out/full` holds the sources.
FROM base AS prepare
COPY . .
RUN pnpm dlx turbo@2.11.7 prune @proof/api-app @proof/app --docker

# The root `prepare` script installs git hooks, which the image has no repo for, so scripts are skipped
# and only the dependency build approved in pnpm-workspace.yaml (esbuild) is run. turbo prune leaves
# out .pnpmfile.mjs, whose checksum the lockfile records, so a frozen install needs it copied in.
FROM base AS deps
COPY --from=prepare /app/out/json/ ./
COPY --from=prepare /app/.pnpmfile.mjs ./
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild

# The web build prerenders by serving itself on `localhost` and fetching it. The container's
# /etc/hosts lists ::1 first, so the server binds IPv6 while the fetch uses 127.0.0.1; prefer IPv4.
FROM deps AS builder
COPY --from=prepare /app/out/full/ ./
ENV NODE_OPTIONS=--dns-result-order=ipv4first
RUN pnpm --filter @proof/app build

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_DIR=/app/apps/app/dist
COPY --from=builder --chown=node:node /app /app
COPY --chown=node:node scripts/release.mjs /app/scripts/release.mjs
# The agent skill, served at /skill.md (apps/api/src/server.ts reads it). Not a workspace package, so
# turbo prune leaves it out of out/full.
COPY --chown=node:node skills /app/skills
USER node
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
