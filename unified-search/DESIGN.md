# Design notes

Why this sample is built the way it is.

Written for someone building their own application on Amazon Bedrock Managed Knowledge
Base. It covers the decisions that are not obvious from reading the code, and the one
architectural fact that drives most of them. Source comments point here rather than
restating the reasoning at each call site.

---

## Where the security boundary sits

This is the thing to internalize before writing any code, because it decides how much of
the authorization model is yours to build.

A managed knowledge base takes the end user's identity as a field on the request:

```json
{
  "knowledgeBaseId": "...",
  "retrievalQuery": { "text": "..." },
  "userContext": { "userId": "user@example.com" }
}
```

Per the [ACL documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-acl.html),
a managed knowledge base provides ACL-aware **filtering**. It answers "what may this
identity see", using the permissions crawled from your connected data sources. "Is this
identity genuine" is answered by your application, which authenticates the end user and
passes a verified identity.

That division is the whole design. `userContext.userId` is a string the service accepts
from your backend, so if any code path lets a client influence it, that is a direct
read-anything privilege escalation, and correct ACL configuration on the knowledge base
will not catch it. Document ACLs work; they are simply answering a different question.

So token verification is the highest-risk component in this application, and it is built
before any retrieval code depends on it.

### Non-negotiable identity rules

1. The email passed as `userId` is derived **server-side** from a cryptographically
   verified token. Never from a request body, query string, or custom header.
2. Verification means: JWKS signature check, `iss` match, `aud` match, `exp`/`nbf` check,
   and the email claim read only from the verified payload.
3. No endpoint accepts a caller-supplied user identity. Not even behind a flag, and not
   even in development, because a dev-only bypass is indistinguishable from a real one
   once it ships.
4. `userContext` is always populated on retrieval calls, so a filtered result set is
   never mistaken for an unfiltered one.

## What the knowledge base provides

The service owns the retrieval stack: vector store, embedding, chunking, reranking,
connectors for Amazon S3, SharePoint, OneDrive, Confluence, Google Drive and web content,
agentic retrieval, multimodal ingest, real-time ACL verification, and ACL debugging
operations. None of that is application code, which is most of why this sample is small.

### API surface

| Purpose                  | API                                                     | Notes                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Search                   | `Retrieve` (`bedrock-agent-runtime`)                    | Takes `userContext` and `retrievalConfiguration`. Returns `retrievalResults[]` with `content.text`, `documentId`, `location`, `metadata`, and a float `score`.                                               |
| Chat                     | `AgenticRetrieveStream`                                 | The generation path, and streaming. Takes `userContext` and an optional `memoryConfiguration` for multi-turn. Plans and iterates over sub-queries, emitting trace events alongside a citation-backed answer. |
| Knowledge base inventory | `bedrock-agent` `ListKnowledgeBases`, `ListDataSources` | Lets an operator see which knowledge base and data sources a query is scoped to.                                                                                                                             |
| Document content         | `GetDocumentContent`                                    | A presigned URL for a document the caller is permitted to read. Enforces the document ACL itself.                                                                                                            |
| ACL debugging            | `CheckIngestedDocumentAcl`, `GetIngestedDocumentAcl`    | `Check…` answers whether one identity may read one document, matching what retrieval does. `Get…` returns a document's full allow list, so it is operator-only. Both live in `bedrock-agent-runtime`.        |

### How ACL filtering behaves

Worth knowing before you connect a real corpus, because these shape the application
around it.

- **Email is the user identifier.** It must match the email that user has in each
  connected data source, so a mismatch means that source contributes nothing for them.
  The domain layer normalizes to lowercase once, so every provider gets a consistent join
  key.
- **Groups resolve automatically** from membership crawled at ingest, so group changes
  land with the next sync.
- **Filtering fails closed.** An ACL evaluation problem omits documents rather than
  returning them, and missing ACL metadata means inaccessible rather than public. The safe
  direction, and it means an empty result set deserves a better message than "no results".
- **Deny overrides allow.**
- **A short page is not the end of results.** Real-time verification can return fewer
  results than requested, so treat result count as a ranking outcome rather than a cursor.
- **A knowledge base may mix ACL-aware and non-ACL sources**, and documents from a
  non-ACL source reach every user. `KnowledgeSource.aclEnabled` carries that into the
  domain so an operator can see which parts of a corpus are unfiltered.

### What stays your application's job

- **Authentication, and therefore authorization.** The boundary above.
- **Score presentation.** `Retrieve` returns a float, meaningful as ordering within one
  response. Turning that into something a user reads is a product decision, made in the
  UI.
- **Action execution.** Retrieval answers questions. An application that also needs tool
  use composes this with something built for it, such as AgentCore Gateway. This sample
  does not, so it ships no stub for one.

---

## Structure

```
backend/src/domain/            provider-agnostic DTOs + the RetrievalProvider port
backend/src/providers/bedrock/ the only place a Bedrock SDK is imported
backend/src/modules/           auth, search, chat, documents, knowledgebase, health
backend/src/cli/               acl-check, an operator tool rather than an endpoint
ui/                            React, Vite
infra/                         CDK: one app, clearly separated stacks
scripts/                       verification and environment helpers
```

One architectural rule, enforced by lint and by a test that compiles a violating probe
file and fails if lint does _not_ reject it: **`@aws-sdk/client-bedrock-agent-runtime` and
`@aws-sdk/client-bedrock-agent` may only be imported under `backend/src/providers/`.**
It keeps SDK types out of view models and UI type files, and keeps the code that attaches
the user's identity to a Bedrock request small enough to review.

`make help` lists every command. Make is a thin façade over the npm scripts and the AWS
CLI and contains no build logic, so `make test` and `npm test` cannot disagree about what
testing means. If you add a target, delegate to a script.

---

## Design decisions

### Repository and tooling

| Decision                                                  | Why                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **npm workspaces monorepo** with a root `verify` script   | One command verifies everything, and one lockfile is what gets audited.                                                                                                                                                                                                                                                    |
| **Backend is ESM**                                        | Not optional: NestJS 12 publishes every `@nestjs/*` package as pure ESM, so a CommonJS backend cannot `require` it.                                                                                                                                                                                                        |
| **Vitest everywhere, not Jest**                           | Follows from ESM, and it unifies the runner across backend, UI, and infra.                                                                                                                                                                                                                                                 |
| **`globals: false` in every Vitest config**               | Test helpers are imported explicitly, keeping them out of production type scope. One consequence worth knowing: React Testing Library registers its automatic `afterEach(cleanup)` only when globals are on, so `ui/src/vitest.setup.ts` wires cleanup by hand. Without it, mounted trees leak between tests in a file.    |
| **cdk-nag runs as a blocking synth-time check**           | Registered through `Validations.of(app).addPlugins(...)`, so violations fail `cdk synth` and land in `policy-validation-report.json`. That makes it a build gate rather than a report someone reads later. Suppressions are `Validations.of(construct).acknowledge({ id, reason })` and each one carries a written reason. |
| **Provider boundary enforced by ESLint, not a unit test** | `no-restricted-imports` with a path-scoped override is the direct mechanism and it fires in the editor. CI additionally compiles a probe file that imports a Bedrock client outside `src/providers/` and fails if lint does _not_ reject it, so weakening the rule breaks the build.                                       |

### Domain model

| Decision                                                                                 | Why                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`UserIdentity` has a private constructor and one factory, `fromVerifiedClaims`**       | Makes it impossible to build an identity from a request body, query parameter, or header, and the factory's name states its precondition. A blank email or subject throws rather than producing an identity that would reach the service as an absent user context.                 |
| **Identity is the required _first_ argument on `search` and `chat`**                     | Turns "forgot to pass the user" into a compile error. Deliberately not optional, not a field on an options object, and not ambient request-scoped state, all three of which can be silently omitted. A test pins the signature, so making it optional has to be a deliberate act.   |
| **`UserIdentity.toString()` masks the local part**                                       | The identity is the value most likely to end up in a log line, so the type that carries it masks itself rather than relying on every call site to remember.                                                                                                                         |
| **`score` is a plain number, not a confidence band**                                     | Presentation is an explicit UI decision rather than a label the API hands over. Documented as ordering within a response, not a cross-query threshold.                                                                                                                              |
| **`SearchHit.title` is optional**                                                        | Retrieval returns document location and metadata, not a guaranteed title, so the title is derived and callers fall back to the URI.                                                                                                                                                 |
| **`SourceType` includes `unknown`**                                                      | New connectors can return a location variant this build has never seen. Surfacing the result with an unrecognized source beats discarding an answer the user is entitled to.                                                                                                        |
| **`AclEvaluationError` is distinct from an empty page**                                  | Without a distinct error, "your permissions could not be evaluated, so this list is incomplete" is indistinguishable from "nothing matched".                                                                                                                                        |
| **Citation shape mirrors the provider's**                                                | The API returns span-plus-references, so keeping the domain shape close keeps the mapping thin, which is where a citation adapter otherwise accumulates coupling. The domain type still carries no SDK import.                                                                      |
| **The fake provider lives in `src/domain/testing/` and is ESLint-blocked outside specs** | A mock flag in application code bundles fixtures into production, and naming a fake clearly is not enough to prevent that.                                                                                                                                                          |
| **The fake models ACL behavior faithfully**                                              | Deny overrides allow, a document with no ACL entry goes to nobody, and a page may be short without being the last page. Tests written against a convenient fiction would pass and then fail against the real provider.                                                              |
| **Import boundaries verified as a matrix, not a single case**                            | ESLint flat config _replaces_ rule options rather than merging them, so two blocks matching one file cannot each contribute a pattern. Adding one rule can therefore disable another's exemption without any error, so `scripts/check-import-boundaries.sh` asserts all nine cells. |

### Authentication

**Amazon Cognito, one identity provider only.** Wiring two doubles the auth code and
invites two implementations that disagree on their storage key. Supporting a different
provider means implementing `TokenVerifier` and binding it in `AuthModule`; nothing else
changes.

| Decision                                                 | Why                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bearer ID token per request, no session store**        | The client presents its ID token on each call and it is verified each time. Identity travels as a request field, so there is no credential exchange to perform and no session state worth keeping. Nothing persists a token.                                                                                                                                                           |
| **Guard registered globally via `APP_GUARD`**            | A per-controller guard protects only the controllers someone remembered to annotate, so a route added later would ship open. The default is closed, and opening a route needs an explicit, greppable `@Public()`. One use today: the health check.                                                                                                                                     |
| **`email_verified` must be `true`**                      | The highest-consequence check and the easiest to omit. Email is the ACL join key, so if a pool permits self-service sign-up, accepting an unverified address lets someone register under a colleague's email and inherit their document access. The string `"true"` is also accepted, for federated mappings; nothing else is.                                                         |
| **`token_use` must be `id`**                             | An access token carries no email claim and is issued under different consent semantics, so it must not stand in as proof of identity.                                                                                                                                                                                                                                                  |
| **Issuer and JWKS URLs derived from the pool ID**        | Configured separately they can drift, and a JWKS URL pointing at a different pool than the issuer being enforced is a verification bypass rather than a typo.                                                                                                                                                                                                                          |
| **All verification failures return one opaque message**  | `Invalid credentials`, naming no cause, because distinguishing a bad signature from an expired token tells an attacker which part of a forged token to fix next. The reason is logged server-side and retained on the error, so a genuine misconfiguration stays diagnosable.                                                                                                          |
| **Refuse to start on missing auth configuration**        | A service that starts and then rejects every request is harder to diagnose than one that will not start, and it reports every missing value at once. CORS is only warned about, because a missing allowlist blocks browser callers rather than breaking verification.                                                                                                                  |
| **Tests sign real JWTs with a real generated keypair**   | A stubbed verifier returning canned claims proves the wiring and nothing about whether a forged token is rejected. The suite covers foreign-key signatures, `alg: none`, algorithm confusion, post-signing tampering, wrong issuer, wrong audience, expired, not-yet-valid, access tokens, and every missing or malformed claim, with the JWKS served locally so no network is needed. |
| **Explicit tests that a caller cannot supply identity**  | Body fields, query parameters, and four plausible headers are all asserted to be ignored. This is the core security property of the application, so it is tested directly rather than inferred.                                                                                                                                                                                        |
| **`no-bypass.spec.ts` scans source for bypass patterns** | `BYPASS_AUTH`, `SKIP_AUTH`, `DISABLE_AUTH`, `NODE_TLS_REJECT_UNAUTHORIZED`, plus an exact count of `@Public()` uses. A bypass gets added under deadline pressure intending to remove it later, so it gets a test rather than a review convention. Comments are stripped before matching, so the reasoning can still be written down.                                                   |

The `algorithms: ['RS256']` pin is defense in depth rather than the control that stops
algorithm attacks here: `jose` does not implement `none`, and verifying HS256 against a
resolved RSA key fails on a key-type mismatch. The pin stays because it would matter under a
different library, and the test covering it reads the source rather than claiming a
behavioral guarantee.

Two details of the guard tests are deliberate. The `@Public()` check counts _occurrences_
rather than files, so a second public route in a file that already has one is still caught.
And the bypass scan strips comments before matching, so contributors can still explain the
reasoning in prose.

### Two modes, explicitly selected

| Mode         | What CDK does                                                                                                                    | For                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **`byo`**    | Provisions no knowledge base. Takes an existing ID and grants the application scoped read access to it.                          | Real corpora, and any connector needing identity-provider setup: SharePoint, OneDrive, Confluence, Google Drive. |
| **`sample`** | Provisions a managed knowledge base, an ACL-enabled S3 data source, a content bucket, and seed documents with a global ACL file. | Evaluating the sample from a clean account, and running the access-control test suite.                           |

**The mode is explicit, never inferred.** Deriving it from the presence of a knowledge base
ID would mean a typo in a variable name silently provisions a knowledge base and starts
incurring ingestion and storage charges. An ambiguous or absent mode is an error.

### Infrastructure

| Decision                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Separate `KnowledgeBaseStack`, deployed only in `sample` mode**     | A `byo` user simply does not deploy it. The app stack stays identical across modes, and no CDK resource could ever modify a user-owned knowledge base.                                                                                                                                                                                                                                                    |
| **In `byo` mode the knowledge base is not a CDK resource at all**     | Not an imported construct, not a custom resource, just an ID passed to the application plus an IAM grant. Nothing CDK does can delete or reconfigure it.                                                                                                                                                                                                                                                  |
| **IAM grants exactly three read actions**                             | `bedrock:Retrieve` and `bedrock:GetDocumentContent` scoped to the one knowledge base ARN, and `bedrock:AgenticRetrieveStream`, which is not resource-scopable, granted as one read-only action. No write or management action, so the application cannot start an ingestion job, change a data source, or delete the knowledge base. A test asserts the wildcard appears on that one action and no other. |
| **A hand-written interface for the S3 connector parameters**          | `connectorParameters` is typed loosely, so a synth-time assertion that `aclEnabled` is present converts a misspelling into a test failure rather than a deploy-time surprise.                                                                                                                                                                                                                             |
| **Warn when no data source has ACL awareness enabled**                | Documents from a non-ACL source reach every user. Surfacing that is the difference between a filtered and an unfiltered corpus, and a `byo` operator may not know which they have.                                                                                                                                                                                                                        |
| **Seed content is synthetic, and its ACLs overlap**                   | 123 documents across eight departments, with five identities holding different combinations and one holding nothing, so authorized, partially authorized, and wholly unauthorized retrieval all have something real to assert against.                                                                                                                                                                    |
| **Seed documents are generated at seed time from a seeded generator** | 120 markdown files in the repository are 120 files a reader scrolls past to reach the code. Deterministic because access-control assertions name which documents an identity retrieves, and a corpus that varied per run would look exactly like a permissions bug when it went wrong.                                                                                                                    |
| **The ACL file is generated at seed time, not committed**             | Every `keyPrefix` is an absolute `s3://` URI carrying the real bucket name, so a committed placeholder would upload cleanly and match nothing.                                                                                                                                                                                                                                                            |
| **`s3deploy.BucketDeployment` not used**                              | It provisions a Lambda-backed custom resource whose role uses an AWS managed policy and broad S3 permissions, which cdk-nag reports as findings to acknowledge. Because this sample demonstrates least privilege, the stack holds infrastructure only and `npm run seed:sample` seeds the example data.                                                                                                   |
| **`bucket.grantRead()` replaced with explicit statements**            | `grantRead` expands to `s3:GetObject*`, `s3:GetBucket*` and `s3:List*`. The documented minimum is `s3:ListBucket` on the bucket and `s3:GetObject` on its objects.                                                                                                                                                                                                                                        |
| **Ingestion is not started by `cdk deploy`**                          | It costs money, and a sample should not begin incurring charges as a side effect of deploying. `make sample` runs it as an explicit step and waits for it.                                                                                                                                                                                                                                                |
| **Memory is opt-in, and refused in `byo` mode**                       | AgentCore Memory is billed separately, so it should not appear as a side effect of a default. In `byo` mode the operator owns their infrastructure, so this stack does not provision an encrypted, separately billed resource into their account from a context flag.                                                                                                                                     |
| **The memory resource uses a customer-managed KMS key**               | It holds generated answers derived from access-controlled documents. A customer managed key gives the account owner control of the key policy, records key usage in AWS CloudTrail, and lets access be revoked independently of the memory resource. The key policy is conditioned on `aws:SourceAccount`, so possession of the ARN is not sufficient.                                                    |
| **Integration tests in a separate Vitest config**                     | Not a tag. A tag that must be excluded is a tag someone eventually forgets to exclude, and the default suite has to run with no AWS credentials.                                                                                                                                                                                                                                                          |

### Backend surface

| Decision                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chat streams Server-Sent Events over `POST`, written by hand rather than with Nest's `@Sse()`** | `@Sse()` is a `GET` route designed for the browser's `EventSource`, and `EventSource` cannot send request headers, so it cannot present a bearer token. Authenticating a `GET` SSE route would mean an identity token in a query string, and therefore in access logs and browser history. Clients use `fetch` with a stream reader, and the wire format stays inspectable with `curl -N`.                                                                                                             |
| **`POST /search`, not `GET` with a query string**                                                 | A search query against a permissioned corpus is itself sensitive: it reveals what someone was looking for even when every result was filtered out. Query strings reach access logs, browser history, and referrer headers.                                                                                                                                                                                                                                                                             |
| **DTOs declare every permitted field, and the pipe runs `forbidNonWhitelisted`**                  | This is the mechanism that rejects a smuggled identity. A client sending `userId`, `actorId`, `userContext`, or a `messages` array gets a `400` rather than having it silently dropped. Dropping would also be safe, but rejecting tells the client immediately that this is not how identity works here.                                                                                                                                                                                              |
| **No message history on the chat request**                                                        | Accepting model-context content from a client would mean round-tripping content derived from access-controlled documents through the browser. History comes from AgentCore Memory, keyed on the verified subject.                                                                                                                                                                                                                                                                                      |
| **Conversation memory is keyed on the verified subject, not the email**                           | Both come from the same token, but an email address can be reassigned to a different person and memory outlives a session. `sessionBinding.actorId` is identity-bearing exactly like `userContext.userId`: memory returns the history stored for that actor, which includes answers derived from documents that actor could read, so the actor must always be the verified user. A `conversationId` is scoped within an actor, so the same value from two users refers to two unrelated conversations. |
| **One global exception filter mapping domain errors to statuses**                                 | It catches the domain error type, not an SDK exception, because the provider has already translated those. Statuses encode whose problem it is: `InvalidQueryError` is the caller's (400), `SourceUnavailableError` the deployment's (502), and `AclEvaluationError` is 503, because a short list with a 200 presents an incomplete answer as a complete one.                                                                                                                                          |
| **`hasUnfilteredSources` computed server-side, treating `unknown` as unfiltered**                 | Each client getting this subtly wrong would be a security misstatement rather than a cosmetic bug, so a source whose ACL status cannot be read is treated as though its documents reach everyone.                                                                                                                                                                                                                                                                                                      |
| **Document fetch is the one endpoint where identity authorizes a named resource**                 | Search and chat filter a result set, so losing the identity returns nothing: visibly broken, and safe. Document fetch authorizes one named resource, so losing the identity would return the document: invisibly broken, and unsafe. Identity is therefore a required argument on the port, and the provider spec asserts it is sent on every operation.                                                                                                                                               |
| **A document that cannot be read returns `404`, with no reason given**                            | "Does not exist" and "you may not read it" are deliberately indistinguishable. For a corpus whose filenames describe their contents, confirming that `finance/acquisition-terms.md` exists is a real leak to someone who cannot read a single file in that folder. `make acl-check` is where an operator gets the actual reason.                                                                                                                                                                       |
| **ACL diagnostics is a CLI, not an endpoint**                                                     | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Why ACL diagnostics is a CLI

`GetIngestedDocumentAcl` returns a document's full allow list, **including other users'
email addresses**, and this application has authentication but no authorization model: a
verified end user, no roles, no group claims. Behind authentication alone, any signed-in
user could enumerate who may read what.

So it is `make acl-check`, running under the operator's own AWS credentials. That puts an
administrative capability under IAM where it belongs and leaves no endpoint to accidentally
expose. Making it in-product would need a group claim first, and the diagnostics code is
already separate from its transport. The README documents the command.

### Frontend

Only the decisions a reader would otherwise have to rediscover. The rest is ordinary React.

| Decision                                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The UI imports the backend's domain types through a `@domain` alias, type-only** | One definition of the wire contract instead of a hand-mirrored copy that drifts until the UI reads a field the API stopped sending. Type-only matters because the barrel also exports runtime values, and `UserIdentity` reaching a browser bundle would put an identity type in the one place identity must never be constructed. A test reads source, so it fails in the editor. |
| **Authorization Code with PKCE, and no other flow**                                | A browser app is a public client and holds no secret. The implicit flow returns tokens in the URL fragment, which puts them in browser history and referrer headers.                                                                                                                                                                                                               |
| **The ID token lives in memory only**                                              | Not `localStorage`, not `sessionStorage`, not a script-readable cookie. A token in `localStorage` is readable by any script that reaches the page, so one compromised dependency becomes every signed-in user's identity, and it outlives the tab.                                                                                                                                 |
| **A page reload re-authenticates, and that cost is accepted**                      | The usual fix is a refresh token, which has to be persisted to be useful, putting a longer-lived credential in the same place. Cognito's own session cookie usually makes the redirect invisible. A production system should use a backend-for-frontend holding the refresh token in an `HttpOnly` cookie, which is a different architecture rather than a bigger storage key.     |
| **Sign-out redirects to the identity provider's `/logout`**                        | Clearing the local token alone leaves the provider session intact, so the next sign-in completes silently and the user appears never to have logged out.                                                                                                                                                                                                                           |
| **Answers render as Markdown; snippets are flattened to plain text**               | An answer is complete Markdown. A snippet is an arbitrary mid-document chunk, so rendering it can open a heading the chunk boundary never closes, or start a list at item four.                                                                                                                                                                                                    |
| **Raw HTML is never enabled**: no `rehype-raw`, no `dangerouslySetInnerHTML`       | Answer text derives from retrieved documents, and anything a corpus can contain can reach the renderer. A test asserts an `<img onerror=…>` in a document renders as inert visible text and fails if the renderer is swapped for `innerHTML`. Model headings are demoted to `h4`/`h5` so a model-authored `#` cannot corrupt the outline a screen reader announces.                |
| **A document opens as a route, not a modal**                                       | A dialog needs a focus trap, `aria-modal`, Escape handling and focus restoration; a route gets all of that from the browser, plus a back button and a shareable URL. Reload re-fetches, which matters because a presigned URL is short-lived.                                                                                                                                      |
| **Only `text/*`, JSON and XML render; anything else becomes a link**               | Allowlisted rather than "not obviously binary". An unrecognised type offered as a download is recoverable; a PDF fed to a Markdown renderer is line noise.                                                                                                                                                                                                                         |
| **The score is used for ordering, not displayed**                                  | The score orders results within one response, and the list is already sorted by it, so showing the number adds little and could be misread as a percentage. The relevance cue the UI gives comes from citations instead.                                                                                                                                                           |
| **An empty result set says it may be a permissions outcome**                       | "Nothing matched" and "you may not see what matched" are indistinguishable from outside, and saying so is more useful than an unqualified "no results". It is the first question a user of this sample will have.                                                                                                                                                                  |
| **A truncated answer keeps its partial text and is labeled `role="alert"`**        | The server commits to `200` before it knows the answer will succeed, so a mid-stream failure is not an HTTP error. Rendering partial text silently presents an incomplete answer as a complete one, which for a permissions question reads as a whole answer.                                                                                                                      |

**Accessibility is treated as a requirement**, not a later pass: dialog roles, focus traps,
Escape handling, accessible names, and a keyboard path to everything. Tests assert behavior
rather than that a page rendered.

### Out of scope

End-to-end SharePoint, OneDrive, Confluence, and Google Drive setup. Each needs
identity-provider configuration in a tenant this sample cannot assume exists, and the
combination would dominate the repository. All four are supported through `byo` mode, and
[sample-managed-kb-connector-setup](https://github.com/aws-samples/sample-managed-kb-connector-setup)
automates the identity-provider side for Microsoft Entra.

Web Crawler is worth naming separately: public web pages have no permission model to crawl,
so a knowledge base whose only source is the crawler is unfiltered by design.

---

## Implementation notes

Five things in the code that are not self-evident, gathered here because source comments
point at this file for the reasoning.

- **The provider normalizes the answer stream.** `domain/chat.ts` defines citation spans as
  offsets into the concatenation of all `answer` events, and `answer-stream.ts` makes that
  true by stripping inline `[n]` markers boundary-safely as deltas arrive. A runtime
  assertion compares the concatenated events against the final answer and withholds
  citations if they disagree, so a client can always trust a span it is given.
- **Grounding is decided by citations, not by a score threshold.** Semantic retrieval
  returns the nearest matches for any query, and the score orders results within one
  response. When an answer cites no source, the UI presents the documents as the closest by
  similarity rather than as matches. Three tests hold that line.
- **ACL enablement is confirmed behaviorally.** The data source APIs do not return a managed
  connector's ACL setting, so the integration suite confirms ACL filtering by retrieving as
  known identities. That is why the suite is not optional, and why `make sample` ends with
  `make test-acl`.
- **No seed document describes its own permissions**, enforced by a test. Retrieved text
  reaches the generator as content, so a document that talks about who may read it steers
  the answer. The general form is worth carrying into any corpus: anything a document can
  say, it can say to the model.
- **Ingestion counts cannot confirm ACLs by themselves.** `make sample-ingest` reports what
  was indexed and defers the verdict to `make test-acl`, which is the check that can tell
  a permissions problem from a corpus that simply had nothing new to index.

## Working practices

1. **Sabotage-test every guardrail.** Deliberately break the thing a check guards and
   confirm the check fails. A guard that has never been observed failing is not yet a
   guard. When the process under test is long-running, confirm the change is actually
   live: a watch-mode server serves the last build that compiled.
2. **Verify behavior before designing around it.** An assumption checked early becomes a
   design decision instead of a rewrite.
3. **Sample generated output more than once.** Where a response is generated by a model,
   draw conclusions from several runs rather than one.

Working notes and throwaway probe scripts stay out of version control, because they carry
live resource identifiers and bucket names that embed an account ID. Anything durable is
promoted into this document or into a test.
