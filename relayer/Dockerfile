# Relayer Dockerfile
# Multi-stage build for the Node.js relayer service

FROM node:18-alpine AS base
WORKDIR /usr/src/app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ sqlite

# ─── Install dependencies ──────────────────────────────────────────────────
FROM base AS deps
COPY package.json ./
RUN npm install --omit=dev

# ─── Final image ───────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /usr/src/app

# Copy node_modules from deps stage
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy source files
COPY src/ ./src/

# Create data directory for SQLite DB and logs
RUN mkdir -p /usr/src/app/data

# Environment defaults (overridden by docker-compose)
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV DB_PATH=/usr/src/app/data/bridge.db
ENV LOG_FILE=/usr/src/app/data/relayer.log

# Non-root user for security
RUN addgroup -S relayer && adduser -S relayer -G relayer
RUN chown -R relayer:relayer /usr/src/app
USER relayer

EXPOSE 3000

CMD ["node", "src/index.js"]
