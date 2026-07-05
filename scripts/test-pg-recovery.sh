#!/usr/bin/env bash
#
# Reproducible PostgreSQL recovery verification.
#
# Brings up the bundled pgvector Postgres, waits until it is healthy, runs the
# gated Markdown-recovery integration test against it, then tears the container
# down. This is the automated path for the one Vitest test that skips without a
# live database (src/db/storage-recovery.integration.test.ts).
#
# Usage:  npm run test:pg
# Requires: Docker (Docker Desktop or docker-compose v1) on PATH.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose"
if ! docker compose version >/dev/null 2>&1; then
  COMPOSE="docker-compose"
fi

export CODEBUDDY_TEST_DATABASE_URL="postgres://codebuddy:codebuddy@localhost:5432/codebuddy"

cleanup() {
  echo "→ tearing down Postgres"
  $COMPOSE -f docker-compose.yml down >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "→ starting Postgres (pgvector/pgvector:pg16)"
$COMPOSE -f docker-compose.yml up -d

echo "→ waiting for Postgres to become healthy"
for _ in $(seq 1 30); do
  if docker exec codebuddy-postgres pg_isready -U codebuddy -d codebuddy >/dev/null 2>&1; then
    echo "  ready"
    break
  fi
  sleep 2
done

echo "→ running the recovery integration test"
npx vitest run src/db/storage-recovery.integration.test.ts
