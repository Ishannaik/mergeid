# syntax=docker/dockerfile:1

# Everything the app needs at run time and nothing else. Prisma 7 reaches
# PostgreSQL through the pure-JS @prisma/adapter-pg driver adapter, so it no
# longer links libssl the way the old Rust query engine did — but `prisma
# migrate` still drives the schema engine, and a runtime without openssl breaks
# the moment that assumption changes. Cheap layer, whole class of "worked in the
# build stage" failures gone.
FROM node:24-bookworm-slim AS runtime-base

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Adds the toolchain the build and migrate stages need. The final runtime stage
# deliberately does not inherit this: pnpm and corepack are build tooling and
# have no business in a production image.
FROM runtime-base AS base

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV COREPACK_HOME=/corepack

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

FROM runtime-base AS runtime

ENV NODE_ENV=production

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist

USER node

CMD ["node", "dist/index.js"]
