.PHONY: dev down up fmt lint test reset compose-up compose-down migrate-db

COMPOSE := docker compose -f infra/docker-compose.yml

up compose-up:
	$(COMPOSE) up -d --wait

down compose-down:
	$(COMPOSE) down

reset:
	$(COMPOSE) down -v

dev: compose-up
	pnpm dev

fmt:
	cargo fmt --all
	pnpm format

migrate-db:
	cargo build -p solobserve-storage --bin solobserve-migrate --release
	@if [ -z "$${DATABASE_URL}" ] && [ -z "$${POSTGRES_URL}" ]; then echo "Set DATABASE_URL or POSTGRES_URL"; exit 1; fi
	DATABASE_URL="$${DATABASE_URL:-$$POSTGRES_URL}" ./target/release/solobserve-migrate

lint:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	pnpm lint

test:
	cargo test --workspace
	pnpm -r run test --if-present
