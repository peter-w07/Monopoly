# Node 24 = the active LTS (Node 20 reached end of life on 2026-04-30); package.json keeps ">=20" as the floor.
FROM node:24-alpine

WORKDIR /app

# Install production dependencies first so this layer is cached between code changes.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Runs as root for now, a deliberate simplicity choice: Coolify-mounted volumes at /data are
# root-owned, and a non-root user would need the volume's ownership fixed first.
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

EXPOSE 3000

# Checked every 5 s so a new or restarted container is marked healthy (and gets traffic) quickly.
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server/index.js"]
