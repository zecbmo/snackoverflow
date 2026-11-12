# syntax=docker/dockerfile:1
# One image: the Fastify server, which also serves the built web app.

FROM node:24-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@10.34.9
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
# The server build bundles every npm dependency, so the runtime image needs no node_modules.
RUN pnpm --filter @snackoverflow/web build \
 && pnpm --filter @snackoverflow/server build

FROM node:24-alpine
# pg_dump for backups; must be at least the Postgres server's major version.
RUN apk add --no-cache postgresql17-client \
 && mkdir -p /backups && chown node:node /backups
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    BACKUP_DIR=/backups
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./public
COPY --from=build /repo/docs/data ./docs/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/index.js"]
