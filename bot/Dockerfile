# ── Stage 1: Install production deps ─────────────────────────
FROM node:20-bookworm-slim AS deps

RUN apt-get update && apt-get install -y \
    libssl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY bot/package.json bot/package-lock.json* ./
COPY prisma/ ./prisma/

# Install ALL deps (including devDependencies for tsc) and generate Prisma
RUN npm ci && npx prisma generate

# ── Stage 2: Build TypeScript ─────────────────────────────────
FROM deps AS builder

COPY bot/tsconfig.json ./
COPY bot/src/ ./src/
RUN npx tsc

# ── Stage 3: Production runner ────────────────────────────────
FROM node:20-bookworm-slim AS runner

RUN apt-get update && apt-get install -y \
    libssl3 zlib1g \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only production node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

# Re-generate Prisma client
RUN npx prisma generate

RUN addgroup --system botuser && adduser --system --ingroup botuser botuser
RUN mkdir -p /data/tdlib && chown -R botuser:botuser /data/tdlib
USER botuser

VOLUME ["/data/tdlib"]

CMD ["node", "dist/index.js"]
