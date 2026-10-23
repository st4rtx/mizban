# Standard multi-stage build (needs npm registry access). For hosts where registries are blocked,
# see Dockerfile.prebuilt + scripts/build-image.sh.
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:20-alpine AS server
WORKDIR /srv
COPY server/package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev --legacy-peer-deps

FROM node:20-alpine
ENV NODE_ENV=production WEB_DIST=/app/web/dist
WORKDIR /app
COPY --from=server /srv/node_modules ./node_modules
COPY --from=server /srv/dist ./dist
COPY --from=server /srv/migrations ./migrations
COPY --from=server /srv/package.json ./package.json
COPY --from=web /web/dist ./web/dist
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/ready || exit 1
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
