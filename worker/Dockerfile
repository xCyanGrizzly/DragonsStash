# ── Stage 1: Install production deps ─────────────────────────
FROM node:20-bookworm-slim AS deps

RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y \
    libssl-dev zlib1g-dev unzip unrar p7zip-full \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY worker/package.json worker/package-lock.json* ./
COPY prisma/ ./prisma/

# Install ALL deps (including devDependencies for tsc) and generate Prisma
RUN npm ci && npx prisma generate

# ── Stage 2: Build TypeScript ─────────────────────────────────
FROM deps AS builder

COPY worker/tsconfig.json ./
COPY worker/src/ ./src/
RUN npx tsc

# ── Stage 3: Production runner ────────────────────────────────
FROM node:20-bookworm-slim AS runner

RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y \
    libssl3 zlib1g unzip unrar p7zip-full \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only production node_modules (prune devDeps)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

# Re-generate Prisma client for production (after pruning isn't needed since we copy all)
RUN npx prisma generate

RUN addgroup --system worker && adduser --system --ingroup worker worker
RUN mkdir -p /data/tdlib /tmp/zips && chown -R worker:worker /data/tdlib /tmp/zips
USER worker

VOLUME ["/data/tdlib", "/tmp/zips"]

CMD ["node", "dist/index.js"]
