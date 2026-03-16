# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dragon's Stash is a self-hosted inventory management system for 3D printing filament, SLA resin, miniature paints, and supplies. It includes an integrated Telegram archive worker that scans channels for ZIP/RAR archives, indexes their contents, and a bot that lets users search and receive packages via Telegram.

## Tech Stack

- **App**: Next.js 16 (App Router), TypeScript 5.9 (strict), Tailwind CSS 4, shadcn/ui
- **Database**: PostgreSQL 16+ via Prisma v7.4 with `@prisma/adapter-pg`
- **Auth**: Auth.js v5 (NextAuth) with credentials + optional GitHub OAuth
- **Worker**: TypeScript + TDLib (via `tdl`) for Telegram channel scanning
- **Bot**: TypeScript + TDLib for Telegram bot interface
- **Forms**: React Hook Form + Zod v4

## Commands

### App (root package.json)
```bash
npm run dev              # Next.js dev server with hot reload
npm run build            # Production build (standalone output)
npm run start            # Production server
npm run lint             # ESLint (next/core-web-vitals + TypeScript)
```

### Database
```bash
npm run db:generate      # Generate Prisma client
npm run db:migrate       # Run migrations (dev mode)
npm run db:push          # Push schema without migrations
npm run db:seed          # Seed database with test data
npm run db:studio        # Prisma Studio UI
npx prisma migrate dev --name <description>  # Create new migration
```

### Worker & Bot (each in their own directory)
```bash
cd worker && npm run dev    # Dev mode with tsx watch
cd worker && npm run build  # TypeScript compile to dist/
cd bot && npm run dev       # Dev mode with tsx watch
cd bot && npm run build     # TypeScript compile to dist/
```

### Dev Environment Setup
```bash
docker compose -f docker-compose.dev.yml up -d   # Start PostgreSQL + worker
npm run dev                                        # Run app locally
```

## Architecture

### Three-Service Design
The project is split into three independent services sharing one PostgreSQL database:
1. **App** (root `src/`): Next.js web UI for inventory management and Telegram admin
2. **Worker** (`worker/`): Scans Telegram source channels, processes archives, uploads to destination channel
3. **Bot** (`bot/`): Telegram bot for user search, package delivery, keyword subscriptions

Services communicate asynchronously via `pg_notify` (e.g., on-demand channel fetches, bot send requests).

### App Source Layout (`src/`)
- `app/(auth)/` — Login/register pages (public)
- `app/(app)/` — Protected routes behind auth middleware (dashboard, filaments, resins, paints, supplies, vendors, locations, settings, stls, telegram, usage)
- `app/api/` — API routes (NextAuth, health check, bot endpoints)
- `data/` — Server-side Prisma query functions (`*.queries.ts`), one file per domain model
- `schemas/` — Zod validation schemas, one file per domain model
- `components/ui/` — shadcn/ui primitives
- `components/shared/` — Reusable business components (data-table, status-badge, color-swatch, stat-card, page-header)
- `components/layout/` — Sidebar and header
- `lib/` — Auth config, Prisma singleton, constants, utilities, Telegram query helpers
- `hooks/` — Custom React hooks (use-modal, use-debounce, use-current-user)
- `types/` — Shared TypeScript types

### Key Patterns
- **Server Components by default** — pages are async server components that fetch data directly. Only interactive components use `"use client"`.
- **Server Actions for mutations** — each page directory has an `actions.ts` file with create/update/delete actions.
- **Data queries centralized** — all Prisma reads go through `src/data/*.queries.ts`, not inline in components.
- **Modal-based CRUD** — add/edit forms use dialog modals, not separate pages.
- **TanStack Table** with server-side pagination for all inventory tables.
- **All Prisma PKs use `cuid()`** string IDs.

### Worker Pipeline
1. Authenticate Telegram account via TDLib (SMS code flow, managed via admin UI)
2. Scan source channels for messages since `lastProcessedMessageId`
3. Detect archives (ZIP/RAR), group multipart sets, extract file listings
4. Hash for dedup, match preview images, extract creator from filename
5. Split files >2GB, upload to destination channel, track progress

### ESLint Scope
ESLint covers `src/` only. The `worker/`, `bot/`, `scripts/`, and `prisma/seed.ts` directories are excluded from linting.

## Docker Deployment

- `docker-compose.yml` — Production: app + worker + bot + db
- `docker-compose.dev.yml` — Dev: db + worker only (app runs locally)
- `docker-entrypoint.sh` — Runs migrations, optional seeding, then starts app
- Bot service uses Docker Compose profiles (`bot` or `full`) — not started by default

## Testing

No test framework is configured. Testing is manual.
