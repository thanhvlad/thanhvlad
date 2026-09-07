FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl

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
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/worker ./worker
COPY --from=build /app/app ./app
COPY --from=build /app/tsconfig.json ./tsconfig.json
RUN npm prune --omit=dev --no-audit --no-fund && npm install --no-save tsx@4 > /dev/null 2>&1 || true

EXPOSE 3000
# Runs migrations then starts the web server; use `npm run worker` for the queue worker.
CMD ["npm", "run", "docker-start"]
