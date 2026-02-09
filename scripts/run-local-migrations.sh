#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="livekit-postgres"
DB_USER="postgres"
DB_NAME="livekit_voice_ops"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Container '${CONTAINER_NAME}' is not running. Start it with:"
  echo "  docker compose -f docker-compose.local.yml up -d"
  exit 1
fi

for migration in db/migrations/*.sql; do
  echo "Applying ${migration}"
  docker exec -i "${CONTAINER_NAME}" psql -U "${DB_USER}" -d "${DB_NAME}" < "${migration}"
done

echo "All migrations applied successfully."
