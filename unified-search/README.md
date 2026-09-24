# Unified Search on Amazon Bedrock Managed Knowledge Base

Enterprise document search and RAG chat over your organization's content, with
**document-level access control**: users only see results from documents they
are permitted to read.

Built on [Amazon Bedrock Managed Knowledge Base](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-build-managed.html),
which manages ingestion, storage, indexing, embedding, and reranking, and offers
native connectors for Amazon S3, SharePoint, OneDrive, Confluence, Google Drive,
and more.

The knowledge base and the identity pool are deployed with CDK; the application itself
runs locally against them. See [Hosting it](#hosting-it) for the shape of a deployment.
Design decisions and the service behavior behind them are in [DESIGN.md](DESIGN.md).

## What it does

Two surfaces, both filtered to the signed-in user:

- **Search.** One query returns a generated answer with citations _and_ the ranked
  documents behind it. The familiar web-search shape: the answer says what your documents
  contain, the list says which documents said it.
- **Chat.** Grounded RAG conversation with inline citations back to source documents, and
  multi-turn history when AgentCore Memory is configured.

## Architecture

```
React SPA  ──id token──▶  Backend (NestJS)
                              │
                              │ verify signature, issuer, audience
                              │ extract email claim
                              ▼
                          userContext: { userId: <verified email> }
                              │
                              ▼
              Bedrock Managed Knowledge Base
             Retrieve · AgenticRetrieveStream
                              │
            ┌─────────────────┴──────────────────┐
            ▼                                     ▼
ACL-aware connectors                      Non-ACL connectors
S3 · SharePoint · OneDrive ·                 Web Crawler
Google Drive · Confluence
```

The id token comes from an Amazon Cognito user pool, which CDK can deploy for you. The
backend and the frontend run as local processes: `make api` and `make web`.

### The security property this depends on

Bedrock Managed Knowledge Base applies **ACL-aware filtering** for the identity your
application supplies. Authenticating the end user is the application's job, so this
application verifies the user and passes that verified identity. Because the identity
travels as an ordinary request field, a caller-supplied email would be a direct
read-anything escalation.

That makes token verification the highest-risk component in the system, which is
why it is built first, before any retrieval code depends on it. Read
[SECURITY.md](SECURITY.md) before touching authentication or the provider layer.

## Repository layout

```
backend/    NestJS API. src/domain/ holds provider-agnostic DTOs and the
            RetrievalProvider port; src/providers/ is the only place a Bedrock
            SDK may be imported (ESLint-enforced).
ui/         React single-page app (Vite).
infra/      AWS CDK application. cdk-nag runs as a blocking synth-time check.
scripts/    Verification and environment helpers used by the Makefile and CI.
```

Design decisions and the API behavior behind them are in [DESIGN.md](DESIGN.md).

## Getting this sample

This sample lives in the
[sample-managed-knowledge-base-patterns](https://github.com/aws-samples/sample-managed-knowledge-base-patterns)
repository alongside other patterns that share no code with it. To get only this
one, have git fetch only this directory. With `--filter=blob:none` the file
contents of the other patterns are never downloaded.

```bash
# Clone the repository structure without any file contents
git clone --filter=blob:none --sparse \
  https://github.com/aws-samples/sample-managed-knowledge-base-patterns.git
cd sample-managed-knowledge-base-patterns

# Fetch only this sample
git sparse-checkout set unified-search

cd unified-search
```

Every command in this README runs from the `unified-search` directory. To
clone the whole repository instead, omit the `--sparse` and `--filter` flags and
change into this directory afterwards.

## Prerequisites

- **Node.js 22+**
- **An AWS account** and credentials with permission to deploy the CDK app
- **A Bedrock Managed Knowledge Base**, in one of two ways. See
  [Knowledge base modes](#knowledge-base-modes) below. You can point this at a
  knowledge base you already have, or let the CDK app deploy a sample one backed
  by Amazon S3.
- **An Amazon Cognito user pool** whose users' email addresses match those in
  your connected data sources, since Bedrock matches document ACLs on the email
  address itself. Email addresses **must be verified** in the pool. An unverified
  address is rejected, because it is attacker-controlled and is the key document
  permissions are matched against. Supporting a different identity provider means
  implementing `TokenVerifier` and binding it in `AuthModule`; nothing else
  changes.

## Knowledge base modes

The knowledge base is the one resource you may well already own, so it is not
assumed. Pick a mode explicitly. It is never inferred, because inferring it from
the presence of an ID would mean a typo silently provisions a knowledge base and
starts incurring ingestion and storage charges.

### `byo`: bring your own

You supply an existing knowledge base ID. **CDK provisions no knowledge base and
never modifies yours**. It is not an imported construct or a custom resource,
just an ID passed to the application plus a read-only IAM grant: `bedrock:Retrieve`
and `bedrock:GetDocumentContent` scoped to that one knowledge base ARN, and
`bedrock:AgenticRetrieveStream` on `*`, because that action does not support
resource-level permissions. `infra/lib/app-stack.ts` explains each statement. Nothing in
the grant can write: the application cannot start an ingestion job, change a data source,
or delete the knowledge base.

Use this for a real corpus, and for any connector that needs identity-provider
setup: SharePoint, OneDrive, Confluence, Google Drive. Create the knowledge base
however you prefer: the console, the CLI, your own CDK stack, or a tool.

Two things to check in this mode:

- **Email addresses must match.** Bedrock matches document ACLs on the email
  address itself, so the email in your Cognito pool must match the email that
  user has in each connected data source. Otherwise documents from that source
  are not returned to them.
- **Confirm your data sources have ACL awareness enabled.** Documents from a
  non-ACL source are returned to _every_ user regardless of identity. The
  application surfaces this per source and warns when none are ACL-enabled, but
  it is worth knowing before you point it at anything sensitive. Web Crawler
  content is public, so it carries no document permissions.

### `sample`: deploy one

CDK provisions a managed knowledge base, a content bucket, an ACL-enabled S3 data
source, and seed documents with a global ACL file granting two test users
different access. This exists so the sample can be evaluated from a clean account
and so the access-control test suite has known ACLs to assert against.

The seed content is synthetic. This mode incurs Bedrock ingestion and storage
charges for as long as the knowledge base exists.

### Optional: connector identity setup

For `byo` users attaching a third-party SaaS connector,
[sample-managed-kb-connector-setup](https://github.com/aws-samples/sample-managed-kb-connector-setup)
automates the identity-provider side (Entra app registration, admin consent, certificates,
Secrets Manager), which CDK cannot do. Not required by this sample, and mentioned only as
an accelerator if that is the connector you are wiring up.

## Local development

```bash
make install         # or: npm install
make verify          # format check, lint, build, test, and cdk synth
make help            # every available target
```

`make` is a thin façade over the npm scripts. It never contains build logic, so
`make test` and `npm test` cannot disagree. Use whichever you prefer; `make` mainly
saves typing on workspace invocations and the AWS lifecycle.

Individual workspaces:

```bash
npm run build --workspace @unified-search/backend
npm test  --workspace @unified-search/ui
npm run synth --workspace @unified-search/infra
```

Run the API and the frontend:

```bash
cp backend/.env.example backend/.env   # then set COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID
cp ui/.env.example ui/.env.local

# terminal 1
npm run start:dev --workspace @unified-search/backend

# terminal 2
npm run dev --workspace @unified-search/ui
```

The backend **refuses to start** without a Cognito user pool and client ID,
reporting every missing value at once, rather than starting and then rejecting
every request.

`GET /health` is the only unauthenticated route. Every other route requires
`Authorization: Bearer <Cognito ID token>` and is closed by default. A new
endpoint is authenticated unless it is explicitly marked `@Public()`.

## API

Every endpoint below requires `Authorization: Bearer <Cognito ID token>`. The
signed-in user's identity is taken from that verified token and nothing else. No
request body, query parameter, or header can influence it. Sending an unexpected
field such as `userId` returns `400` rather than being silently ignored.

| Endpoint                          | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `POST /search`                    | Search, filtered to what the caller may read             |
| `POST /chat`                      | Streaming RAG answer with citations (Server-Sent Events) |
| `POST /documents/content`         | A document's content, if the caller may read it          |
| `GET /knowledgebase/sources`      | Data sources, and whether any are unfiltered             |
| `GET /knowledgebase/capabilities` | What this deployment supports, e.g. conversation memory  |
| `GET /health`                     | Liveness. The only unauthenticated route                 |

### Search

```bash
curl -sS localhost:3001/search \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text": "quarterly revenue forecast", "maxResults": 5}'
```

`POST` rather than `GET` deliberately: a search query against a permissioned corpus
reveals what someone was looking for even when the results were denied, and query
strings end up in access logs, browser history, and referrer headers.

### Chat

Returns `text/event-stream`. Each frame's `data` is one event from the domain
model (`answer`, `trace`, `sources`, or `citations`), and the stream ends with an
`event: done` frame.

```bash
curl -sS -N localhost:3001/chat \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"message": "What is the Q3 revenue forecast?", "conversationId": "conv-1"}'
```

```
event: message
data: {"kind":"trace","trace":{"label":"Retrieval","detail":"Starting retrieval for query: ..."}}

event: message
data: {"kind":"answer","text":"The projected Q3 revenue forecast is "}

event: message
data: {"kind":"citations","citations":[{"span":{"start":0,"end":52},"text":"...","references":[...]}]}

event: done
data: {}
```

Three things worth knowing when writing a client:

- **Concatenate `answer` events in arrival order.** Citation `span` offsets index
  into that concatenation, so anything else misaligns every highlight.
- **A stream that ends without `done` failed.** Once the first byte is sent the
  response is committed to `200`, so a mid-stream failure arrives as
  `event: error` rather than an HTTP status. Treat a missing `done` as an error;
  otherwise a truncated answer renders as a complete one.
- **Use `fetch`, not `EventSource`.** `EventSource` cannot send request headers, so
  it cannot present the bearer token. That is why this endpoint is a `POST`. The
  alternative would be putting an identity token in a query string.

Conversation history lives in AgentCore Memory and is keyed on the verified
identity, so the API accepts no message history. `conversationId` is scoped
_within_ a user: the same value from two different users refers to two unrelated
conversations. If no memory resource is configured, chat is single-turn and
`GET /knowledgebase/capabilities` reports `conversationMemory: false` so a client
can say so rather than appear to forget.

### Document content

Resolves a search hit to the document behind it. Both identifiers come from the hit:
`documentId` is `SearchHit.id` (the `s3://` form, not the `https://` URL in
`SearchHit.uri`), and `dataSourceId` is `SearchHit.dataSourceId`.

```bash
curl -sS localhost:3001/documents/content \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"documentId": "s3://amzn-s3-demo-bucket/content/finance/q3.md", "dataSourceId": "WXYZ5678GH"}'
```

```json
{
  "mimeType": "text/plain",
  "url": "https://<bedrock-managed-bucket>.s3.amazonaws.com/...",
  "expiresInSeconds": 300,
  "sizeBytes": 706
}
```

Two things worth knowing when writing a client:

- **`url` is a bearer capability with a five-minute life.** It carries its own
  signature and is not protected by this API's authentication, so anyone holding it
  can read the document until it expires. Do not log it, persist it, or send it
  anywhere. Do not attach your `Authorization` header when fetching it either. The
  URL is on a different origin and does not need it.
- **`404` does not mean the document is missing.** It means _not available_, which
  covers both "does not exist" and "you may not read it". The two are deliberately
  indistinguishable: reporting `403` for the second would let a user who can read
  nothing in a folder still confirm what is filed there. Use `make acl-check` when
  you need the real reason.

This is the only endpoint where identity authorizes a _named resource_ rather than
filtering a result set, and the failure modes are not symmetric: a search that loses
the caller's identity returns an empty page, while a document fetch that loses it
would return the document.

## Operator tools

### Why a CLI and not an endpoint

ACL-aware retrieval **fails closed**, which is the safe direction and means a result set
tells you what a user may read rather than why. Bedrock provides two operations that answer
the "why" directly, `CheckIngestedDocumentAcl` and `GetIngestedDocumentAcl`, and
`make acl-check` wraps them, so "can this person see that document?" has a first-class
answer.

It is deliberately **not** an HTTP endpoint. `GetIngestedDocumentAcl` returns a
document's full allow list, including other users' email addresses, and this
application has authentication but no authorization model: no roles, no group
claims. Behind authentication alone, any signed-in user could enumerate who may
read what. As a CLI it runs under the operator's own AWS credentials, which puts
access under IAM where an administrative capability belongs, and leaves no endpoint
to accidentally expose.

```bash
# Who is allowed to read this document?
make acl-check DOC=s3://amzn-s3-demo-bucket/content/finance/q3-revenue-forecast.md

# Can one specific user read it?
make acl-check DOC=s3://amzn-s3-demo-bucket/content/finance/q3.md AS_USER=akua_mansa@example.com

# Full options
cd backend && npm run acl-check -- --help
```

The knowledge base and data source IDs are resolved from the deployed stack, so
they cannot drift from what is running. Requires
`bedrock:CheckIngestedDocumentAcl` and `bedrock:GetIngestedDocumentAcl`.

Two details the command handles for you:

- The document identifier is the `s3://` form, a search hit's `id`. The `uri`
  field is an `https://` display link, not a document identifier.
- The per-user check answers only the access question, so an identifier that is
  not in the knowledge base also reports "no access". The command cross-checks
  both operations and tells you whether the document was not ingested or not
  permitted.

### A note on `npm install`

Dependency overrides in the root `package.json` are applied during dependency
resolution, so adding a package incrementally with `npm install <pkg>` can leave
an already-locked transitive dependency at its old version. If `npm audit`
reports something an override should have fixed, delete `node_modules` and
`package-lock.json` and reinstall.

## Deployment

CDK deploys the knowledge base, and optionally a Cognito user pool and an AgentCore Memory
resource. The API and the frontend then run locally against them.

```bash
make bootstrap                             # once per account and region
make sample IDENTITY=true MEMORY=true      # everything, end to end
make sample-env                            # write backend/.env and ui/.env.local
make api                                   # terminal 1
make web                                   # terminal 2, then sign in at :5173
make sample-destroy IDENTITY=true MEMORY=true
```

`make sample` deploys, seeds, ingests, verifies access control and, with
`IDENTITY=true`, creates the sign-in accounts, printing a generated password once.

Two optional pieces, both off by default because each costs money or duplicates something
you may already have:

| Flag            | Adds                                 | Why it is optional                                                                       |
| --------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `IDENTITY=true` | A Cognito user pool and hosted UI    | Most operators have an identity provider already. Without one you cannot sign in at all. |
| `MEMORY=true`   | AgentCore Memory for multi-turn chat | Billed separately. Without it chat is single-turn, and the API says so.                  |

### Customizing ingestion

Three things are worth knowing before you adapt this sample to your own content.

**Chunking and embedding are handled for you.** With the service-managed embedding model
there is nothing to tune and no flag for it, which is most of why there is so little
ingestion code here. If you need control over chunking, that comes with supplying your own
embedding model.

**Parsing is handled for you too.** Smart Parsing selects a parser per document type, and
it is what a managed knowledge base uses. The sample data source sets it explicitly in
`infra/lib/knowledge-base-stack.ts` so you can see where the setting lives:
`vectorIngestionConfiguration.parsingConfiguration`, a top-level sibling of
`dataSourceConfiguration` rather than part of the connector envelope that holds the other
data-source settings.

**Custom metadata attributes** are always on, because they cost nothing and are most of
what makes filtering useful. Every seeded document gets a `.metadata.json` sidecar beside
it carrying seven business facets: `department`, `docType`, `project`, `fiscalQuarter`,
`fiscalYear`, `effectiveDate`, `topics`, one of each supported type, so every filter
operator has something to match. The attribute set is declared in
`infra/lib/seed-metadata.ts` and populated in `infra/lib/seed-corpus.ts`; replace both to
model your own facets. Filter on them at query time exactly as you would on the
service-populated `_`-prefixed attributes:

```jsonc
{
  "andAll": [
    { "equals": { "key": "department", "value": "finance" } },
    { "greaterThanOrEquals": { "key": "fiscalYear", "value": 2025 } },
  ],
}
```

Sidecars sit inside the crawled prefix, unlike the global ACL file, which has to sit
outside it. Two reasons that is safe: the connector counts them as metadata rather than
documents so they are never returned as a search result, and being inside means each
sidecar inherits the ACL entry covering its department prefix, keeping a document's
attributes on the same side of the permission boundary as the document.

`make sample-env` writes both `.env` files from the deployed stacks rather than having
you copy identifiers by hand, so the configuration always matches what is deployed.

### Verifying it works

```bash
make test-acl                              # ACL filtering against the live knowledge base

make api                                   # test-e2e drives the running API, so start it first
SEED_PASSWORD='...' make test-e2e          # the whole stack, with real tokens
```

`make test-e2e` is the only check that exercises the full path: token verification, the
guard, the controller, the provider, and Bedrock's filtering. It signs in as two seeded
users, confirms they receive different documents for the same query, confirms a third
user named in no access entry receives nothing, and confirms an unauthenticated or forged
request is rejected. It drives the API over HTTP at `localhost:3001`, so `make api` has to
be running in another terminal; set `API_BASE_URL` to point it somewhere else.
`SEED_PASSWORD` is the password `make sample-users` printed.

### The sample corpus

`make sample` seeds **123 documents** across eight departments: three hand-written, 120
generated at seed time from a deterministic generator, so the repository stays small and
the corpus is reproducible. Permissions are granted by folder, which makes the access
boundary visible in the UI.

| Account                         | Can read                                            |
| ------------------------------- | --------------------------------------------------- |
| `alejandro_rosalez@example.com` | `shared`, `finance`, `legal`                        |
| `akua_mansa@example.com`        | `shared`, `engineering`, `operations`, `security`   |
| `martha_rivera@example.com`     | `hr`, `legal`, `security`, notably **not** `shared` |
| `mary_major@example.com`        | `sales`, `operations`                               |
| `john_stiles@example.com`       | nothing, named in no ACL entry                      |

The outsider signing in successfully and seeing no results is the sample working, not a
fault: authentication and authorization are separate concerns.

Sign in as two different users and run the same query to see the point of the whole
thing. A broad question returns 78 documents to Akua, 53 to Alejandro, and 56 to Martha,
drawn from the departments each is permitted to read.

The UI captions its list "top N most relevant" rather than offering a next page, because
retrieval is a ranking operation: it returns the best matches for a query, which is what a
question-answering surface wants. If you need to enumerate every document matching a
predicate, that is a different job than retrieval and belongs on your data source.

`make sample` is deliberately one command with a verification step at the end:
nothing is searchable until ingestion completes, and running a query before then
returns empty results that look exactly like a permissions problem.

Ingestion is **not** started by `cdk deploy`, because it costs money and a sample
should not begin incurring charges as a side effect of deploying.

## Hosting it

Nothing here is always-on: the API and the frontend are local processes, so what you
deploy is the knowledge base and, optionally, the user pool and memory resource. That
keeps the sample cheap to evaluate and keeps the interesting part, the identity boundary,
in plain sight rather than inside a container definition.

Hosting it for real is a conventional web deployment, and the application is written to
suit one. The backend is a stateless container: it holds no session, persists no token,
and reads its whole configuration from environment variables, so it scales horizontally
behind a load balancer with no sticky sessions. Two things are worth getting right.

- **Stream through the whole path.** Chat is Server-Sent Events, so anything that buffers
  responses turns an incremental answer into a long pause followed by a wall of text.
  Disable response buffering on the load balancer and any CDN in front of it, and set idle
  timeouts longer than your slowest answer.
- **Terminate TLS in front and pass the token through unchanged.** The bearer token is the
  authorization identity, so a proxy that rewrites or drops the `Authorization` header
  breaks access control rather than degrading it. Keep `CORS_ALLOWED_ORIGINS` set to the
  exact frontend origin.

The frontend is a static bundle from `npm run build`, suited to object storage behind a
CDN. It is a public OAuth client and holds no secret, so its only deployment-time
configuration is the API origin and the Cognito details.

## Cost

There is no always-on compute to pay for, so cost is usage-based and driven by the
knowledge base: Bedrock ingestion when documents are indexed, storage for as long as the
knowledge base exists, and retrieval per query. `MEMORY=true` adds AgentCore Memory, which
is billed separately. A Cognito pool for a handful of evaluation accounts is negligible.

Price the usage-based part against your own corpus size and query volume rather than this
sample's 123 documents, and remember that storage accrues while the knowledge base sits
idle: `make sample-destroy` is how you stop paying for it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). It includes a short list of things this
project will not accept.

## License

MIT-0. See [LICENSE](../LICENSE).
