# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    CONFIG_PATH=/app/data/config.json \
    ENV_FILE=/app/data/.env

WORKDIR /app

RUN apk add --no-cache tini su-exec

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN chmod +x docker-entrypoint.sh \
 && mkdir -p /app/data \
 && chown node:node /app/data \
 && chmod 700 /app/data

LABEL org.opencontainers.image.title="Server-Panel" \
      org.opencontainers.image.description="Self-hosted panel to monitor and manage Linux servers over SSH" \
      org.opencontainers.image.licenses="MIT"

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${PORT}/" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "server.js"]
