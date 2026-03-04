#!/bin/sh
set -e

# Guard: refuse to start with the placeholder AUTH_SECRET
if [ "$AUTH_SECRET" = "change-me-to-a-random-secret-in-production" ] || [ -z "$AUTH_SECRET" ]; then
  echo "ERROR: AUTH_SECRET is not set or still uses the placeholder value."
  echo "Generate one with: openssl rand -base64 32"
  echo "Then set it in your .env file."
  exit 1
fi

echo "Running database migrations..."
./node_modules/.bin/prisma migrate deploy

if [ "$SEED_DATABASE" = "true" ]; then
  echo "Seeding database..."
  ./node_modules/.bin/prisma db seed || echo "Seeding skipped or already done."
fi

echo "Starting application..."
exec "$@"
