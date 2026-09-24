# Unified Search on Bedrock Managed Knowledge Base
#
# A discoverable façade, not a build system. Every target delegates to an npm
# script or the AWS CLI, and npm scripts remain the source of truth for build,
# lint, test, and synth — so `make test` and `npm test` can never disagree about
# what testing means.
#
# Make earns its place on three things npm scripts handle badly here:
#   * workspace invocations, where the real command is
#     `npm run start:dev --workspace @unified-search/backend`
#   * the integration suite, which needs two environment variables and a config path
#   * the AWS lifecycle, which is multi-step and otherwise lives in prose
#
# If you add a target, delegate. Build logic in a Makefile is how the two
# vocabularies drift apart.

SHELL := /bin/bash
.DEFAULT_GOAL := help

BACKEND := @unified-search/backend
UI      := @unified-search/ui
INFRA   := @unified-search/infra

# Region and stage are overridable: `make sample-deploy STAGE=test AWS_REGION=us-west-2`
AWS_REGION ?= us-east-1
STAGE      ?= dev
KB_STACK       := UnifiedSearch-$(STAGE)-KnowledgeBase
MEMORY_STACK   := UnifiedSearch-$(STAGE)-Memory
IDENTITY_STACK := UnifiedSearch-$(STAGE)-Identity

export AWS_REGION

.PHONY: help
help: ## Show this help
	@echo 'Unified Search — available targets'
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo 'Variables: STAGE=$(STAGE) AWS_REGION=$(AWS_REGION)'

# ─── Development ─────────────────────────────────────────────────────────────

.PHONY: install
install: ## Install all workspace dependencies
	npm install

.PHONY: verify
verify: ## Everything CI runs: format, lint, build, test, synth
	npm run verify

.PHONY: test
test: ## Unit tests, all workspaces (no AWS credentials needed)
	npm test

.PHONY: lint
lint: ## Lint all workspaces
	npm run lint

.PHONY: format
format: ## Rewrite files with Prettier
	npm run format

.PHONY: build
build: ## Build all workspaces
	npm run build

.PHONY: boundaries
boundaries: ## Assert the ESLint import boundaries still bite
	./scripts/check-import-boundaries.sh

.PHONY: api
api: ## Run the backend in watch mode
	npm run start:dev --workspace $(BACKEND)

.PHONY: web
web: ## Run the frontend dev server
	npm run dev --workspace $(UI)

# ─── Infrastructure ──────────────────────────────────────────────────────────

.PHONY: synth
synth: ## Synthesize byo, sample, sample with memory, and sample with identity
	npm run synth

.PHONY: bootstrap
bootstrap: ## Bootstrap CDK in this account and region
	npm run bootstrap --workspace $(INFRA)

# Conversation memory is opt-in even in sample mode, because AgentCore Memory is
# billed separately and a resource that costs money should not appear by default:
#   make sample MEMORY=true
MEMORY ?= false

# A Cognito user pool is optional too, and for a different reason: most operators have
# an identity provider already. Without one there is no way to sign in, and every
# endpoint requires a verified token — so an evaluator starting from a clean account
# wants this:
#   make sample IDENTITY=true
IDENTITY ?= false

CDK_CONTEXT := -c kbMode=sample \
  $(if $(filter true,$(MEMORY)),-c memory=true,) \
  $(if $(filter true,$(IDENTITY)),-c identity=true,)

.PHONY: sample
sample: ## Deploy, seed, and ingest the sample end to end (INCURS AWS CHARGES)
	@echo '==> Deploying'
	@$(MAKE) --no-print-directory sample-deploy
	@echo '==> Seeding'
	@$(MAKE) --no-print-directory sample-seed
	@echo '==> Ingesting (this is what makes documents searchable)'
	@$(MAKE) --no-print-directory sample-ingest
	@echo '==> Verifying access control against the deployed knowledge base'
	@$(MAKE) --no-print-directory test-acl
ifeq ($(IDENTITY),true)
	@echo '==> Creating sign-in accounts for the seeded identities'
	@$(MAKE) --no-print-directory sample-users
endif
	@echo
	@echo 'Sample is up and its access control is verified.'
	@$(MAKE) --no-print-directory sample-ids

.PHONY: sample-deploy
sample-deploy: ## Deploy the sample knowledge base (INCURS AWS CHARGES)
	cd infra && npx cdk deploy $(CDK_CONTEXT) --all --require-approval never

.PHONY: sample-users
sample-users: ## Create sign-in accounts for the seeded identities (needs IDENTITY=true)
	npm run seed:users --workspace $(INFRA) -- --stage $(STAGE)

.PHONY: sample-seed
sample-seed: ## Upload seed documents and the generated ACL file
	npm run seed:sample --workspace $(INFRA) -- --stage $(STAGE)

.PHONY: sample-ingest
sample-ingest: ## Start ingestion and wait for it, checking what was indexed
	npm run ingest:sample --workspace $(INFRA) -- --stage $(STAGE)

.PHONY: sample-destroy
sample-destroy: ## Tear down the sample knowledge base and its buckets
	cd infra && npx cdk destroy $(CDK_CONTEXT) --all

.PHONY: sample-ids
sample-ids: ## Print the deployed IDs, ready to paste into the two .env files
	@aws cloudformation describe-stacks --stack-name $(KB_STACK) \
	  --query 'Stacks[0].Outputs[?OutputKey==`KnowledgeBaseId`||OutputKey==`DataSourceId`||OutputKey==`ContentBucketName`].[OutputKey,OutputValue]' \
	  --output text
	@aws cloudformation describe-stacks --stack-name $(MEMORY_STACK) \
	  --query 'Stacks[0].Outputs[?OutputKey==`MemoryId`].[OutputKey,OutputValue]' \
	  --output text 2>/dev/null || true
	@aws cloudformation describe-stacks --stack-name $(IDENTITY_STACK) \
	  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`||OutputKey==`UserPoolClientId`||OutputKey==`HostedUiDomain`].[OutputKey,OutputValue]' \
	  --output text 2>/dev/null || true

# Writes the two .env files from the deployed stacks, so the identifiers are never
# copied by hand.
.PHONY: sample-env
sample-env: ## Write backend/.env and ui/.env.local from the deployed stacks
	@./scripts/write-env.sh $(STAGE) $(AWS_REGION)

# ─── Access control verification ─────────────────────────────────────────────

# Resolved from the stack rather than hardcoded, so this cannot drift from what is
# actually deployed. Override for a knowledge base this repo did not create:
#   make test-acl KB_ID=ABCDE12345
KB_ID ?= $(shell aws cloudformation describe-stacks --stack-name $(KB_STACK) \
           --query 'Stacks[0].Outputs[?OutputKey==`KnowledgeBaseId`].OutputValue' \
           --output text 2>/dev/null)

# Resolved the same way, and optional: without a memory resource the conversation
# memory tests skip and everything else still runs.
MEMORY_ID ?= $(shell aws cloudformation describe-stacks --stack-name $(MEMORY_STACK) \
               --query 'Stacks[0].Outputs[?OutputKey==`MemoryId`].OutputValue' \
               --output text 2>/dev/null)

DS_ID ?= $(shell aws cloudformation describe-stacks --stack-name $(KB_STACK) \
           --query 'Stacks[0].Outputs[?OutputKey==`DataSourceId`].OutputValue' \
           --output text 2>/dev/null)

# Access control fails closed: a denied document, an empty index, and a query that
# matched nothing all return no results. This asks the service which case applies.
#
#   make acl-check DOC=s3://bucket/content/finance/q3-revenue-forecast.md
#   make acl-check DOC=s3://... AS_USER=akua_mansa@example.com
#
# An operator tool, not an API endpoint: listing access entries reveals other users'
# identities, so it runs under your own AWS credentials rather than the service's.
#
# `AS_USER` rather than `USER`, because Make inherits `USER` from the environment and
# would otherwise check the operator's own login name when no user is given.
.PHONY: acl-check
acl-check: ## Explain why a document is or is not visible to a user (DOC=, AS_USER=)
	@if [ -z "$(DOC)" ]; then \
	  echo "Usage: make acl-check DOC=s3://bucket/key [AS_USER=someone@example.com]"; \
	  echo; \
	  cd backend && npm run --silent acl-check -- --help; \
	  exit 1; \
	fi
	@cd backend && npm run --silent acl-check -- \
	  --kb $(KB_ID) --ds $(DS_ID) --document '$(DOC)' \
	  $(if $(AS_USER),--user '$(AS_USER)',)

.PHONY: test-acl
test-acl: ## Verify document-level ACL filtering against the live knowledge base
	@if [ -z "$(KB_ID)" ]; then \
	  echo "No knowledge base found. Deploy one with 'make sample-deploy', or pass KB_ID=..."; \
	  exit 1; \
	fi
	@echo "Testing ACL filtering against $(KB_ID) in $(AWS_REGION)"
	@if [ -z "$(MEMORY_ID)" ]; then \
	  echo "No memory resource found: conversation memory tests will skip."; \
	  echo "Deploy one with 'make sample-deploy MEMORY=true' to include them."; \
	else \
	  echo "Including conversation memory tests against $(MEMORY_ID)"; \
	fi
	cd backend && ACL_TEST_KNOWLEDGE_BASE_ID=$(KB_ID) MEMORY_ID=$(MEMORY_ID) \
	  npm run test:integration

# The only check that exercises the whole path: real Cognito tokens, over HTTP, through
# token verification and the guard and the controller, to Bedrock's ACL filtering.
# `test-acl` calls the provider directly and so cannot catch a mistake in that wiring.
#
#   make api                                  # terminal 1
#   SEED_PASSWORD='...' make test-e2e         # terminal 2
.PHONY: test-e2e
test-e2e: ## Verify the whole stack with real tokens (needs make api running)
	@./scripts/verify-e2e.sh $(STAGE) $(AWS_REGION)
