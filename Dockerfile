FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl curl

FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --include=dev --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

FROM base AS runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/worker ./worker
COPY --from=build /app/app ./app
COPY --from=build /app/tsconfig.json ./tsconfig.json
# tsx runs the worker entrypoint from source; everything else is dev-only.
RUN npm prune --omit=dev --no-audit --no-fund && npm install --no-save --no-audit --no-fund tsx@4

EXPOSE 3000
# The platform's own health check should also hit /healthz; this one lets
# `docker ps` and Compose report the container as healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/healthz || exit 1

# Runs migrations then starts the web server; use `npm run worker` for the queue worker.
CMD ["npm", "run", "docker-start"]
