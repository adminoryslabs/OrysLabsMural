# syntax=docker/dockerfile:1
# Two production images: the Next.js application, and one worker image that
# serves both the collaboration server and the one-shot migration job.
#
# Debian slim (glibc) is used on purpose: @node-rs/argon2 ships prebuilt
# linux-x64-gnu binaries, so no native toolchain is needed at build time.

# Full dependency tree, needed only to build. Never shipped.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Runtime dependencies only. This is what the worker image ships, and it is why
# eslint, vitest, typescript, drizzle-kit and the type packages never travel to
# the server. `tsx` is a runtime dependency on purpose: the worker executes
# TypeScript directly.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# The worker is a plain Node process: it never renders a page and never touches
# the canvas. Next and Excalidraw are still production dependencies because the
# web application needs them, but here they are 600 MB of dead weight that would
# be pushed and pulled on every single deploy. Versions stay lockfile-pinned;
# only whole packages the worker's import graph cannot reach are removed.
# `react` is deliberately kept — some shared lib/ modules import it.
RUN rm -rf \
  node_modules/next \
  node_modules/@next \
  node_modules/@excalidraw \
  node_modules/mermaid \
  node_modules/@mermaid-js \
  node_modules/cytoscape \
  node_modules/cytoscape-cose-bilkent \
  node_modules/cytoscape-fcose \
  node_modules/@img \
  node_modules/es-toolkit \
  node_modules/react-dom

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are inlined into the bundle at build time, so the public
# websocket URL has to be known here, not only at runtime.
ARG NEXT_PUBLIC_YJS_URL
ENV NEXT_PUBLIC_YJS_URL=${NEXT_PUBLIC_YJS_URL}
# The build never touches the database; a placeholder URL satisfies config loaders.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
RUN npm run build

# --- Worker: collaboration server and migration job --------------------------
# One image, two entry points. Both need exactly the same files and the same
# dependencies, so shipping them separately meant pulling the same bytes twice.
#
# It shares `lib/` with the app on purpose: the board authority rules and the
# session validation exist exactly once, so the websocket server can never drift
# from what the web app enforces. That shared code is why the build context is
# the repository root rather than ./yjs-server.
#
#   collaboration server : default command
#   migrations           : npx tsx scripts/migrate.ts
#   seeding              : npx tsx scripts/seed.ts
FROM node:22-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV YJS_PORT=1234
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY lib ./lib
COPY yjs-server ./yjs-server
COPY scripts ./scripts
COPY drizzle ./drizzle
EXPOSE 1234
CMD ["npx", "tsx", "yjs-server/index.ts"]

# --- Application -------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Standalone output: the server plus only the dependencies it actually traced.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
