# syntax=docker/dockerfile:1
# Production images for the Next.js app and for the one-shot migration job.
# Debian slim (glibc) is used on purpose: @node-rs/argon2 ships prebuilt
# linux-x64-gnu binaries, so no native toolchain is needed at build time.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

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

# --- Migration job -----------------------------------------------------------
# Run as a one-shot service before the app starts (see docker-compose.prod.yml).
FROM node:22-bookworm-slim AS migrator
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY drizzle ./drizzle
COPY lib ./lib
COPY scripts ./scripts
CMD ["npx", "tsx", "scripts/migrate.ts"]

# --- Collaboration (Yjs websocket) server ------------------------------------
# A separate long-lived process. It shares `lib/` with the app on purpose: the
# board authority rules and the session validation exist exactly once, so the
# websocket server can never drift from what the web app enforces. That shared
# code is why the build context is the repository root rather than ./yjs-server.
FROM node:22-bookworm-slim AS yjs
WORKDIR /app
ENV NODE_ENV=production
ENV YJS_PORT=1234
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY lib ./lib
COPY yjs-server ./yjs-server
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
