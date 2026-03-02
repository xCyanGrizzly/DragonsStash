# Dragon's Stash

A self-hosted inventory management system for 3D printing filament, SLA resin, and miniature paints — with an integrated Telegram archive worker that ingests, indexes, and redistributes archive files. Built with a dark, data-dense UI inspired by [Spoolman](https://github.com/Donkie/Spoolman).

## Features

### Inventory Management

- **Filament tracking** with spool weight, material type, color swatches, and usage logging
- **SLA resin management** with bottle sizes, resin types, and remaining volume tracking
- **Miniature paint inventory** with product lines, finishes, and volume tracking
- **Dashboard** with inventory stats, low-stock alerts, and recent activity
- **Vendor and location management** to organize your supplies
- **Usage logging** to track consumption over time
- **Low-stock alerts** with configurable threshold percentage
- **Dark theme** optimized for workshop environments
- **Role-based auth** with admin and user roles

### Telegram Archive Worker

- **Channel scanning** — monitors configured Telegram channels (including forum topics) for archive files (ZIP, RAR, 7z)
- **Multipart detection** — automatically groups related multipart archives (`.part01.rar`, `.z01`, `.001`, etc.)
- **Content indexing** — extracts file listings from archives and stores them in the database
- **Destination upload** — re-uploads processed archives to a configured destination channel
- **Byte-level splitting** — splits files exceeding Telegram's 2GB limit into uploadable chunks
- **Full repack** — concatenates and re-splits multipart sets where any single part exceeds 2GB
- **Progress tracking** — resumes from the last successfully processed message on each run
- **Upload verification** — confirms files reached the destination before marking them complete
- **Preview matching** — associates photo messages with their corresponding archive sets

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript (strict mode)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Auth.js v5 (credentials + GitHub OAuth)
- **UI**: Tailwind CSS, shadcn/ui, Lucide icons
- **Tables**: TanStack Table v8 with server-side pagination
- **Validation**: Zod v4 + React Hook Form
- **Worker**: Node.js + TDLib (via tdl)
- **Archive handling**: unrar, zlib

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 16+ (or Docker)
- Telegram API credentials (for the worker — get from [my.telegram.org/apps](https://my.telegram.org/apps))

### Development Setup

1. Clone the repository:

```bash
git clone https://github.com/your-username/dragons-stash.git
cd dragons-stash
```

2. Install dependencies:

```bash
npm install
```

3. Start a PostgreSQL database (using Docker):

```bash
docker compose -f docker-compose.dev.yml up -d db
```

4. Copy the environment file and update values:

```bash
cp .env.example .env.local
```

5. Run database migrations and seed:

```bash
npx prisma migrate dev     # Run migrations
npx prisma db seed         # Seed with sample data (admin/user accounts + inventory)
```

6. Start the development server:

```bash
npm run dev
```

7. Open [http://localhost:3000](http://localhost:3000) and log in:
   - **Admin**: admin@dragonsstash.local / password123
   - **User**: user@dragonsstash.local / password123

### Running the Worker in Development

To also run the Telegram worker alongside the dev database:

```bash
docker compose -f docker-compose.dev.yml up -d
```

This starts both the PostgreSQL database and the worker container. The worker reads `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from your `.env.local` file.

## Docker Deployment

### Full Stack (App + Worker + Database)

Run the entire application from Docker:

```bash
cp .env.example .env
# Edit .env — set TELEGRAM_API_ID, TELEGRAM_API_HASH, and a secure AUTH_SECRET
docker compose up -d
```

The app will be available at [http://localhost:3000](http://localhost:3000).

### Seeding the Database

To seed the database with sample data on first run:

```bash
SEED_DATABASE=true docker compose up -d
```

This creates default admin/user accounts and sample inventory data. The seed runs once during the app container's entrypoint (before the Next.js server starts). On subsequent runs without `SEED_DATABASE=true`, seeding is skipped automatically.

You can also seed manually at any time:

```bash
npx prisma db seed
```

### Development Mode (DB + Worker Only)

If you prefer to run the Next.js app locally with hot reload:

```bash
docker compose -f docker-compose.dev.yml up -d   # Start DB + worker
npm run dev                                        # Start Next.js locally
```

### Rebuilding After Code Changes

```bash
docker compose build && docker compose up -d --force-recreate
```

To rebuild only the worker:

```bash
docker compose build worker && docker compose up -d worker --force-recreate
```

### Viewing Logs

```bash
docker compose logs -f worker   # Worker logs
docker compose logs -f app      # App logs
docker compose logs -f db       # Database logs
```

## Project Structure

```
src/
  app/
    (auth)/          # Login/Register pages
    (app)/           # Authenticated app pages
      dashboard/     # Overview stats
      filaments/     # Filament CRUD
      resins/        # Resin CRUD
      paints/        # Paint CRUD
      vendors/       # Vendor management
      locations/     # Location management
      settings/      # User preferences
    api/
      auth/          # NextAuth API routes
      health/        # Health check endpoint
  components/
    layout/          # Sidebar, header, navigation
    shared/          # Reusable data table components
    ui/              # shadcn/ui components
  data/              # Prisma query functions
  hooks/             # React hooks
  lib/               # Auth config, Prisma client, constants
  schemas/           # Zod validation schemas
  types/             # TypeScript type definitions
worker/
  src/
    archive/         # Archive detection, multipart grouping, byte-level splitting
    db/              # Prisma queries for packages, progress tracking
    preview/         # Preview image matching
    tdlib/           # TDLib client, channel scanning, topic/forum handling
    upload/          # Telegram upload logic
    util/            # Config, logger
    worker.ts        # Main processing pipeline
    index.ts         # Entry point + scheduler
prisma/
  schema.prisma      # Database schema
  seed.ts            # Seed data
```

## Configuration

Environment variables (see `.env.example`):

### Application

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `AUTH_SECRET` | NextAuth secret key | Required |
| `AUTH_TRUST_HOST` | Trust the host header | `true` |
| `AUTH_GITHUB_ID` | GitHub OAuth client ID | Optional |
| `AUTH_GITHUB_SECRET` | GitHub OAuth client secret | Optional |
| `NEXT_PUBLIC_APP_URL` | Public application URL | `http://localhost:3000` |
| `SEED_DATABASE` | Seed the database on app container start | `false` |

### Telegram Worker

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_API_ID` | Telegram API ID (from [my.telegram.org](https://my.telegram.org/apps)) | Required |
| `TELEGRAM_API_HASH` | Telegram API hash | Required |
| `WORKER_INTERVAL_MINUTES` | Scan interval in minutes | `60` |
| `WORKER_TEMP_DIR` | Temp directory for downloads | `/tmp/zips` |
| `TDLIB_STATE_DIR` | TDLib session state persistence directory | `/data/tdlib` |
| `WORKER_MAX_ZIP_SIZE_MB` | Max archive size to process (MB) | `4096` |
| `MULTIPART_TIMEOUT_HOURS` | Max time span for multipart set parts (0 = no limit) | `0` |
| `LOG_LEVEL` | Worker log level (`debug`, `info`, `warn`, `error`) | `info` |

## Health Check

The application exposes a health check endpoint at `/api/health` that verifies database connectivity.

```bash
curl http://localhost:3000/api/health
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
