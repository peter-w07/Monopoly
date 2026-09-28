FROM node:20-alpine

WORKDIR /app

# Install production dependencies first so this layer is cached between code changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Runs as root on purpose: Coolify-mounted volumes at /data are root-owned.
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server/index.js"]
