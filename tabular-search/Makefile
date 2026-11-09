.PHONY: install lint test synth

install:
	uv sync --frozen
	cd infra && npm ci

lint:
	uv run --frozen ruff check
	uv run --frozen ruff format --check
	uv run --frozen mypy
	cd infra && npx tsc

test:
	uv run --frozen pytest
	cd infra && npm test

# Synthesizes the app as cdk deploy would, through bin/app.ts and cdk.json,
# without deploying. cdk-nag fails it on any unacknowledged finding.
synth:
	cd infra && npx cdk synth --quiet
