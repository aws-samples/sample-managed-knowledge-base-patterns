PY_PATHS := infra/functions/demo_user_password:infra/functions/interceptor:infra/functions/pre_token_generation:scripts

.PHONY: install test lint

install:
	uv sync --frozen
	cd agent && uv sync --frozen
	cd infra && npm ci
	cd frontend && npm ci

test:
	uv run --frozen pytest
	cd agent && uv run --frozen pytest
	cd infra && npm test
	cd frontend && npm test

lint:
	uv run --frozen ruff check infra/functions scripts
	uv run --frozen ruff format --check infra/functions scripts
	MYPYPATH=$(PY_PATHS) uv run --frozen mypy --strict --explicit-package-bases infra/functions scripts
	cd agent && uv run --frozen ruff check && uv run --frozen ruff format --check && uv run --frozen mypy --strict src tests
	cd frontend && npm run lint && npm run typecheck
