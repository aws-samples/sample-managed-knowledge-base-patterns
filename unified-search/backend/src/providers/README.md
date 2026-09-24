# Provider layer

This is the **only** place in the codebase permitted to import
`@aws-sdk/client-bedrock-agent` or `@aws-sdk/client-bedrock-agent-runtime`. The
restriction is enforced by ESLint (`no-restricted-imports` in
`backend/eslint.config.mjs`), not by convention, and CI runs lint as a blocking
step.

## Why the boundary exists

Two reasons, and the second is the one that matters more.

**Stability.** Without a boundary, SDK types tend to spread into shared
interfaces, controller return types, persisted records, and frontend type
modules. Keeping them here keeps the rest of the code small and stable, and
keeps the API contract expressed in domain terms.

**Reviewability.** This layer is where the caller's identity is attached to
outbound retrieval calls as `userContext.userId`. Everything a user is permitted
to see depends on that field being correct, so the set of files that can
construct a Bedrock request needs to stay small enough to review carefully. See
[SECURITY.md](../../../SECURITY.md).

## What goes here

- `bedrock/`: the `RetrievalProvider` implementation backed by
  `Retrieve` and `AgenticRetrieveStream`, plus the mapping from
  Bedrock response shapes to domain DTOs.

## What does not go here

Business logic and HTTP concerns. This layer translates between the domain model
and the Bedrock APIs, and does nothing else. Code outside it depends on the
`RetrievalProvider` port in `src/domain/`, never on a provider directly.
