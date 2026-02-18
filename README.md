# Dragon's Stash

A self-hosted inventory management system for 3D printing filament, SLA resin, and miniature paints. Built with a dark, data-dense UI inspired by [Spoolman](https://github.com/Donkie/Spoolman).

## Features

- **Filament tracking** with spool weight, material type, color swatches, and usage logging
- **SLA resin management** with bottle sizes, resin types, and remaining volume tracking
- **Miniature paint inventory** with product lines, finishes, and volume tracking
- **Dashboard** with inventory stats, low-stock alerts, and recent activity
- **Vendor and location management** to organize your supplies
- **Usage logging** to track consumption over time
- **Low-stock alerts** with configurable threshold percentage
- **Dark theme** optimized for workshop environments
- **Role-based auth** with admin and user roles
- **Docker-ready** for easy self-hosting

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript (strict mode)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Auth.js v5 (credentials + GitHub OAuth)
- **UI**: Tailwind CSS, shadcn/ui, Lucide icons
- **Tables**: TanStack Table v8 with server-side pagination
- **Validation**: Zod v4 + React Hook Form

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 16+ (or Docker)

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
docker compose -f docker-compose.dev.yml up -d
```

4. Copy the environment file and update values:

```bash
cp .env.example .env.local
```

5. Run database migrations and seed:

```bash
npx prisma migrate dev
npx prisma db seed
```

6. Start the development server:

```bash
npm run dev
```

7. Open [http://localhost:3000](http://localhost:3000) and log in:
   - **Admin**: admin@dragonsstash.local / password123
   - **User**: user@dragonsstash.local / password123

### Docker Deployment

```bash
docker compose up -d
```

This starts both the application and PostgreSQL database. The app will be available at `http://localhost:3000`.

To seed the database on first run:

```bash
SEED_DATABASE=true docker compose up -d
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
prisma/
  schema.prisma      # Database schema
  seed.ts            # Seed data
```

## Configuration

Environment variables (see `.env.example`):

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `AUTH_SECRET` | NextAuth secret key | Required |
| `AUTH_TRUST_HOST` | Trust the host header | `true` |
| `AUTH_GITHUB_ID` | GitHub OAuth client ID | Optional |
| `AUTH_GITHUB_SECRET` | GitHub OAuth client secret | Optional |
| `NEXT_PUBLIC_APP_URL` | Public application URL | `http://localhost:3000` |

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
