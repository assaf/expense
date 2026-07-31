FROM node:26-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g corepack && corepack enable pnpm

# --- BUILDER ---
FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --config.verify-deps-before-run=false run build:prisma \
    && pnpm --config.verify-deps-before-run=false run build

# --- RUNNER ---
FROM node:26-slim AS runner
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g corepack && corepack enable pnpm

WORKDIR /app

ENV HOSTNAME="0.0.0.0"
ENV PORT=3000
EXPOSE 3000

# Persistent state lives in /app/data — mount a volume here in Coolify.
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules/.pnpm/node_modules/@prisma/engines ./build/node_modules/.pnpm/node_modules/@prisma/engines
COPY --from=builder /app/prisma/generated ./prisma/generated
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm --config.verify-deps-before-run=false install --prod --frozen-lockfile --ignore-scripts

# Create the data directory owned by node so the app can write state.
RUN mkdir -p /app/data/images && chown -R node:node /app/data

USER node

ENV pnpm_config_verify_deps_before_run=false
CMD ["pnpm", "start"]
