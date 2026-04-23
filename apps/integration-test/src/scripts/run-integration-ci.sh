#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

PORT=3001

function stop_services() {
  echo "🔴 - Stopping backend..."
  kill $(lsof -t -i:$PORT)

  echo "🔴 - Taking down auxiliary services..."
  docker compose -f "$PROJECT_ROOT/docker/compose-files/docker-compose-integration-test.yml" down
}

trap stop_services EXIT INT TERM

DATABASE_URL="postgresql://postgres:nagmani@localhost:5432/postgres"

echo "Starting auxilary services"
docker compose -f "$PROJECT_ROOT/docker/compose-files/docker-compose-integration-test.yml" up -d --wait

echo '🟡 - Waiting for database to be ready...'
$PROJECT_ROOT/apps/integration-test/src/scripts/wait-for-it.sh localhost:5432 -- echo "database has started"

echo "Applying Prisma migrations (Better Auth tables only)"
cd $PROJECT_ROOT/packages/database && DATABASE_URL="postgresql://postgres:nagmani@localhost:5432/postgres" pnpm dlx prisma migrate deploy --schema "$PROJECT_ROOT/packages/database/prisma/schema.prisma"

echo "Apply sqlx control-plane migrations"
cd "$PROJECT_ROOT" && cargo build -p solobserve-storage --release --bin solobserve-migrate
DATABASE_URL="postgresql://postgres:nagmani@localhost:5432/postgres" ./target/release/solobserve-migrate

echo "Generate Client"
cd $PROJECT_ROOT/packages/database && pnpm dlx prisma generate --schema "$PROJECT_ROOT/packages/database/prisma/schema.prisma"

echo '🟡 - Starting backend server...'
cd $PROJECT_ROOT/apps/backend && PORT=$PORT pnpm run dev:ci &
BACKEND_PID=$!

echo "backend pid $BACKEND_PID"

echo '🟡 - Waiting for backend to be ready...'
$PROJECT_ROOT/apps/integration-test/src/scripts/wait-for-it.sh localhost:3001 -- echo "backend has started"

echo "Run integration test"
cd $PROJECT_ROOT/apps/integration-test && vitest --run
