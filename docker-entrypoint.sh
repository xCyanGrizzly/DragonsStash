#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy

if [ "$SEED_DATABASE" = "true" ]; then
  echo "Seeding database..."
  npx prisma db seed || echo "Seeding skipped or already done."
fi

echo "Starting application..."
exec "$@"
