# Build the server and the frontend in one pass, then ship only what runs.
FROM node:22-alpine AS build
WORKDIR /app

# Manifests first so the dependency layer survives source-only changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
ENV WEB_DIST=/app/web/dist
WORKDIR /app

# Copying the pruned tree wholesale keeps npm's hoisted workspace layout intact.
COPY --from=build /app /app

USER node
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8099/api/health || exit 1

CMD ["node", "server/dist/index.js"]
