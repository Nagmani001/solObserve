# Template Monorepo

Turborepo monorepo with a Next.js frontend, Express backend, PostgreSQL database, authentication (Better Auth), and email support.

## Project Structure

```
apps/
  backend/           Express REST API (port 3001)
  web/               Next.js 16 frontend (port 3000)
  integration-test/  Vitest integration tests

packages/
  common/            Shared Zod schemas, types, and constants
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

### Environment Variables

Copy the example env files and fill in the values:

```sh
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env
cp packages/database/.env.example packages/database/.env
```

Key variables:

| File                     | Variable                  | Description                                    |
| ------------------------ | ------------------------- | ---------------------------------------------- |
| `packages/database/.env` | `DATABASE_URL`            | PostgreSQL connection string                   |
| `apps/backend/.env`      | `BETTER_AUTH_SECRET`      | Secret for Better Auth                         |
| `apps/backend/.env`      | `BETTER_AUTH_URL`         | Backend URL (default: `http://localhost:3001`) |
| `apps/backend/.env`      | `GITHUB_CLIENT_ID/SECRET` | GitHub OAuth credentials                       |
| `apps/backend/.env`      | `GOOGLE_CLIENT_ID/SECRET` | Google OAuth credentials                       |
| `apps/backend/.env`      | `SMTP_*`                  | SMTP credentials (use Mailhog in dev)          |
| `apps/web/.env`          | `NEXT_PUBLIC_BACKEND_URL` | Backend URL for client-side requests           |
| `apps/web/.env`          | `SERVER_BACKEND_URL`      | Backend URL for server-side requests           |

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

Run everything — database, Mailhog, backend, and frontend — in containers:

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

### With Docker (auxiliary services only)

Run only the database and Mailhog, while developing backend and web locally:

```sh
docker compose -f ./docker/compose-files/docker-compose-auxilary-services.yml up -d --wait
```

- PostgreSQL: `localhost:5432`
- Mailhog SMTP: `localhost:1025`
- Mailhog UI: http://localhost:8025

### With Docker (production)

Run backend and web containers against an external database:

```sh
docker compose -f ./docker/compose-files/docker-compose-production.yml up -d --wait --build
```

## Authentication

Authentication is handled by [Better Auth](https://www.better-auth.com/) with the following methods:

- **Email & password** — sign up, sign in, forgot password with email OTP verification
- **Social logins** — GitHub and Google OAuth

Auth is configured in `apps/backend/src/lib/auth.ts` and uses the Prisma adapter. The frontend auth client lives in `apps/web/lib/auth.ts`.

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

## CI/CD

GitHub Actions workflows are in `.github/workflows/`:

- **CI** (`ci.yml`) — runs on PRs and pushes to `main`. Builds the project and runs integration tests.

## Scripts

| Command            | Description                 |
| ------------------ | --------------------------- |
| `pnpm dev`         | Start all dev servers       |
| `pnpm build`       | Build all apps and packages |
| `pnpm lint`        | Lint all packages           |
| `pnpm format`      | Format code with Prettier   |
| `pnpm check-types` | Type-check all packages     |
