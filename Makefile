.PHONY: dev down up fmt lint test reset compose-up compose-down

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

lint:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets -- -D warnings
	pnpm lint

test:
	cargo test --workspace
	pnpm -r run test --if-present
