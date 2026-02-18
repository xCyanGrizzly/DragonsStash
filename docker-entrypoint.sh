#!/bin/sh
set -e

echo "Dragon's Stash - Starting..."

# Run database migrations
echo "Running database migrations..."
npx prisma migrate deploy 2>/dev/null || {
  echo "WARNING: Migration failed. Database may not be ready yet."
  echo "Retrying in 5 seconds..."
  sleep 5
  npx prisma migrate deploy
}

echo "Migrations complete."

# Optionally seed database
if [ "$SEED_DATABASE" = "true" ]; then
  echo "Seeding database..."
  npx prisma db seed || echo "Seeding skipped or already done."
fi

echo "Starting application..."
exec "$@"
