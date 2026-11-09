FROM --platform=$BUILDPLATFORM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build-base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM build-base AS dependencies
ENV PRISMA_CLI_BINARY_TARGETS=linux-arm64-openssl-3.0.x,debian-openssl-3.0.x
COPY package.json yarn.lock ./
RUN --mount=type=cache,id=medicine-yarn-native-v1,target=/usr/local/share/.cache/yarn,sharing=locked \
    yarn install --frozen-lockfile --non-interactive --ignore-optional --network-timeout 60000

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma7.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build yarn prisma:generate \
    && yarn build

FROM build-base AS production-dependencies
COPY package.json yarn.lock ./
RUN --mount=type=cache,id=medicine-yarn-native-v1,target=/usr/local/share/.cache/yarn,sharing=locked \
    yarn install --frozen-lockfile --non-interactive --production=true --ignore-optional --network-timeout 60000

FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM runtime-base AS migrate
ENV PRISMA_SCHEMA_ENGINE_BINARY=/app/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json prisma7.config.ts ./
COPY prisma ./prisma
RUN test -x /app/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x
USER node
ENTRYPOINT ["./node_modules/.bin/prisma"]
CMD ["migrate", "deploy", "--config", "prisma7.config.ts"]

FROM runtime-base AS runtime
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
CMD ["node", "dist/main.js"]
