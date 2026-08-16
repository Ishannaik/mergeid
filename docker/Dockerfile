# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV COREPACK_HOME=/corepack

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && corepack prepare pnpm@10.27.0 --activate \
    && chmod -R a+rX "${COREPACK_HOME}"

FROM base AS build

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=tmpfs,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store --package-import-method=copy

COPY prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN pnpm build

FROM base AS production-dependencies

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=tmpfs,target=/pnpm/store pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store --package-import-method=copy

FROM base AS migrate

COPY --from=build /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml prisma.config.ts ./
COPY prisma ./prisma

USER node

CMD ["pnpm", "db:deploy"]

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist

USER node

CMD ["node", "dist/index.js"]
