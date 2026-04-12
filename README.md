# Template Monorepo

Turborepo monorepo with a Next.js frontend, Express backend, PostgreSQL database, and email support.

## Project Structure

```
apps/
  backend/           Express REST API (port 3001)
  web/               Next.js 16 frontend (port 3000)
  integration-test/  Vitest integration tests

packages/
  database/          Prisma ORM with PostgreSQL
  email/             Email service (Resend + SMTP/Nodemailer)
  ui/                Shared React components (shadcn/ui)
  eslint-config/     Shared ESLint config
  typescript-config/ Shared TypeScript config

docker/
  backend/           Backend Dockerfile
  web/               Web Dockerfile
  compose-files/     Docker Compose files
```

## Setup

### Prerequisites

- Node.js >= 18
- pnpm 9
- Docker (for database / full stack)

### Without Docker

1. **Install dependencies**

   ```sh
   pnpm install
   ```

2. **Start a PostgreSQL instance** (or use an existing one) and set the connection string in `packages/database/.env`:

   ```
   DATABASE_URL="postgresql://postgres:password@localhost:5432/postgres"
   ```

3. **Run database migrations and generate the Prisma client**

   ```sh
   cd packages/database
   pnpm dlx prisma migrate dev --name init
   pnpm dlx prisma generate
   ```

4. **Start the dev servers**

   ```sh
   pnpm dev
   ```

   This starts both the backend (port 3001) and web (port 3000) in watch mode.

### With Docker (full stack)

Run everything — database, mailhog, backend, and frontend — in containers:

```sh
docker compose -f ./docker/compose-files/docker-compose.yml up -d --wait --build
```

- Web: http://localhost:3000
- Backend: http://localhost:3001
- Mailhog UI: http://localhost:8025

To stop:

```sh
docker compose -f ./docker/compose-files/docker-compose.yml down
```

## Running Integration Tests

The integration test suite spins up a database, runs migrations, starts the backend, and runs Vitest.

**Locally:**

```sh
cd apps/integration-test
bash src/scripts/run-integration.sh
```

**In CI (hardcoded env vars):**

```sh
cd apps/integration-test
bash src/scripts/run-integration-ci.sh
```

## Scripts

| Command            | Description                 |
| ------------------ | --------------------------- |
| `pnpm dev`         | Start all dev servers       |
| `pnpm build`       | Build all apps and packages |
| `pnpm lint`        | Lint all packages           |
| `pnpm format`      | Format code with Prettier   |
| `pnpm check-types` | Type-check all packages     |
