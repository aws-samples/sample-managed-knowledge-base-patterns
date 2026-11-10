# Observed behavior: AgenticRetrieveStream with AgentCore Memory in a multi-user application

These notes record what we observed when running the scripts in `scripts/` against the live services in the US West (Oregon) Region (us-west-2) in October and November 2026, with boto3 1.43.96 and the application role in `infra/app-role-policy.json`, assumed per user with the session tag `userId=<sub>`. They are observations from a small sample, not service commitments. Each row says how to reproduce it with this repository.

## 1. What we observed

| # | Observation | How to reproduce |
|---|---|---|
| 1 | Public boto3 ≥ 1.43.72 models `memoryConfiguration`, `SessionHistoryLoad`, `BedrockAgentCoreMemory`, and the `memoryRetrieve` action. Recent botocore requires Python ≥ 3.10. | A `python -c` check of the boto3 service model for `bedrock-agent-runtime` |
| 2 | With `sessionBinding`, `messages` carries only the current question and the follow-up resolves correctly ("it" → the Mac VPN / Frankfurt gateway). | `scripts/turn.py` turn 2 (README §4); e2e check "turn 2 restored prior history" |
| 3 | Exactly one event with two payloads (USER question, ASSISTANT answer) is written per turn. No tool results, no retrieved memory records, no reasoning. | `ListEvents` on the session after turn 1 |
| 4 | `SessionHistoryLoad` is the first trace event, before `SpeculativeRetrieval`; it reports `_memory_event_count` and `_memory_message_count` (scope-level, one item) and takes ~200 ms. | The trace printed by `scripts/turn.py` for any turn |
| 5 | On a **new** session the cold-start long-term lookup rides `SpeculativeRetrieval`: `retrievalMetadata` lists both `BedrockKnowledgeBase` and `BedrockAgentCoreMemory`, and memory items carry `_memory_query` (= the raw question), `_memory_namespace_path`, `_memory_strategy_id`, `_memory_record_count`. On a **warm** session speculative retrieval queries only the knowledge base. | README §4 turns 1 and 3 versus turn 2; e2e check "warm session" |
| 6 | The planner independently decides to search memory: for Liam (no office in memory) `Planning/SUCCEEDED` carried `memoryRetrieve('employee office location')`, followed by `Retrieval` with `retrievalType: BedrockAgentCoreMemory` and "Retrieved 0 long-term memory record(s)". For Maya the speculative memory hit was enough and the planner issued no `memoryRetrieve` (see §3.6). | README §4 turns 3 and 4 |
| 7 | Cross-conversation personalization works: an office fact stated only in an IT conversation personalized an HR answer in a new session ("Since you're based in the Frankfurt office… 30 days… March 31"). | README §4 turn 3; e2e section 4; screenshot `docs/screenshots/03-answer-maya.png` |
| 8 | Per-user isolation: same handler, same memory, same question — Liam's memory lookups were scoped to `/anycompany/<liam-sub>/` only and his answer was generic. Liam reading Maya's session through the app returns `[]`. | README §4 turn 4; e2e sections 5 and 6 |
| 9 | **IAM condition keys work through AgenticRetrieveStream.** The app role's memory statements require `bedrock-agentcore:actorId == ${aws:PrincipalTag/userId}` (ListEvents, CreateEvent, ListSessions) and `namespacePath like /anycompany/${aws:PrincipalTag/userId}/*` (RetrieveMemoryRecords, ListMemoryRecords). Assumed for Maya, the role allowed Maya's request and denied a request that deliberately bound Liam's actorId: `SessionHistoryLoad/FAILED AccessDeniedException (bedrock-agentcore:ListEvents)`; `SpeculativeRetrieval` finished `SUCCEEDED` (its knowledge base leg worked) with `AccessDeniedException (bedrock-agentcore:RetrieveMemoryRecords)` in its `failures`; the answer was still produced from the knowledge base, and Liam's session count stayed the same. Direct ListSessions, ListEvents, and ListMemoryRecords for Liam from Maya's session were denied, as were the root `/anycompany/`, the sibling prefixes `/anycompany/<maya-sub>x` and `/anycompany/<maya-sub>x/`, and `/anycompany//`. `/anycompany/<maya-sub>` without the trailing `/` was allowed and returned only Maya's records, so the service treats it as `/anycompany/<maya-sub>/`; `.` and `..` segments were rejected with `ValidationException`. The probe also checks that the trust policy refuses AssumeRole without the tag, with an empty, malformed, or extra tag, or without `SourceIdentity`. | `scripts/abac_probe.py`; `infra/app-role-policy.json`, `infra/app-role-trust-policy.json` |
| 10 | Memory failures soft-fail: the request completed and answered from the knowledge base while memory calls were denied. | `scripts/abac_probe.py` |
| 11 | `persistenceMode: NONE` restores history (2 events, 4 messages) and writes nothing. | `scripts/turn.py --no-persist --session <id>` on a two-turn session; the event count stays at 2 |
| 12 | Backward compatible: without `memoryConfiguration`, the trace contains no memory steps. | An `AgenticRetrieveStream` call built by `build_request` with `memoryConfiguration` removed |
| 13 | **Document ACLs hold through AgenticRetrieveStream.** With an ACL-enabled S3 data source and `userContext.userId` = verified email: Maya's on-call question retrieved `engineering/oncall.md` and answered "500 USD or 450 EUR"; Sofia's identical question retrieved only `hr/` and `sales/` chunks, including in the planner's follow-up `retrieve('on-call stipend compensation policy')`, and answered that no stipend is documented. Symmetric for `sales/commission-plan.md`. | README §4, the two ACL turns; e2e section 1 |
| 13a | `Retrieve` without `userContext` on the ACL-enabled data source returns 0 results, as documented. | A `Retrieve` call on the knowledge base without `userContext` |
| 13b | ACL email matching was case-insensitive in our test (`MAYA@example.com` matched `maya@example.com`). The docs say the email must match exactly, so don't rely on it; the backend lowercases the email. | A `Retrieve` call with `userContext.userId` in upper case |
| 13c | An ACL-enabled S3 data source needs `aclConfiguration.globalAccessControlListS3Uri` in the same bucket; with `filterConfiguration.inclusionPrefixes: ["docs/"]` the ACL file itself is not ingested. 11 documents scanned, 11 indexed, 0 failed. | The sync statistics printed by `python infra/setup.py` |
| 13d | `GetDocumentContent` on an ACL-enabled data source without `userContext` is rejected with `ValidationException` ("UserContext is required for ACL-aware data sources"). With `userContext`, the knowledge base applies the ACL to the email in the request, not to the caller: Sofia's session got `AccessDeniedException` for `engineering/oncall.md` with her own email and the document's content with Maya's. This is why the holders of the retrieval permissions are part of the ACL boundary (README, Security). | `GetDocumentContent` through the app role for `engineering/oncall.md`, with no `userContext`, with the caller's email, and with another user's email |
| 14 | The app can read the same memory resource directly for the UI: `ListSessions` for the conversation list, `ListEvents` for history, `ListMemoryRecords` for "what memory knows about you". No parallel store. | The backend endpoints in `backend/app.py`; the UI |
| 15 | `ListSessions` for an actor that has never written an event returns `ResourceNotFoundException` ("Actor ... not found"), not an empty list. The backend maps it to `[]`. | `scripts/abac_probe.py` before Liam's first turn; `backend/assistant.py` |
| 16 | CloudWatch: `AWS/Bedrock/KnowledgeBases` has `Invocations`, `ClientErrors`, `TotalIterationCount` with `Operation=AgenticRetrieveStream`; `AWS/Bedrock-AgentCore` has `Invocations`, `Latency`, `Errors`, `UserErrors`, `CreationCount`, and `Input/OutputTokenUsage` per `Operation` / `Resource` / `StrategyId` / `StrategyType`. | CloudWatch `ListMetrics` for the two namespaces |
| 17 | Validation messages are specific and actionable for each of these invalid requests: earlier turns in `messages` together with `sessionBinding`; `memoryId` without `sessionBinding`; `persistenceMode: DEFAULT` with `generateResponse: false`; an unresolved `{actorId}` template in `namespacePath`; both `namespace` and `namespacePath`; two `retrievalConfigs` entries; a nonexistent `memoryId`. | Edit the request from `build_request` into each shape and call `AgenticRetrieveStream` |

## 2. Measured numbers (small sample, managed model, us-west-2)

| Metric | Observed |
|---|---|
| End-to-end turn latency (1 KB, ACL on, memory on, `maxAgentIteration` 3) | 3.6 – 9.6 s |
| `SessionHistoryLoad` (IN_PROGRESS → SUCCEEDED) | 190 – 222 ms |
| Speculative retrieval incl. memory leg | 1.7 – 5.9 s (KB and memory in parallel) |
| Long-term extraction lag (summary strategy) | first record 81 s after turn 2; earlier runs ~2 min |
| Long-term extraction lag (user-preference strategy) | 3 structured records ~2 min after an explicit "for future answers: I prefer…" statement; **none** extracted from incidental mentions ("I'm on a Mac in Frankfurt") across 6 earlier sessions |
| S3 sync (11 small docs, ACL on) | one ingestion job, all 11 indexed |

Treat these as what we observed, not as service commitments.

## 3. Things to know when you build on this

### 3.1 Which strategy carries which kind of personalization
Two strategies, two behaviours:
* **Summary** (`/anycompany/{actorId}/summaries/{sessionId}/`) captured incidental facts ("Mac, Frankfurt office")
  from ordinary questions and drove the office-based PTO personalization.
* **User preference** (`/anycompany/{actorId}/profile/`) extracted nothing from incidental mentions but produced
  three clean structured records from an explicit statement ("I prefer short bullet-point answers without
  tables. I'm on the Platform team and I always deploy to eu-central-1 first"), e.g.
  `{"context":"Deployment operations","preference":"Always deploys to eu-central-1 first",...}`.
  A new session then honored all three: bulleted answer, no table, "Since you're Platform team,
  eu-central-1 goes first".
Recommendation: use both. Summaries give you "what we discussed" and preferences give you
"how this person wants to be answered"; preference extraction is selective by design.

### 3.2 The summary strategy records a conversation even when the user shared no facts
Liam's first (generic) PTO question produced a summary record. His next new-session question then got
"based on what you shared before…". Isolation was correct, but any conversation creates records. So
"no records" is not a test for isolation; check the namespace on each record.

### 3.3 `SpeculativeRetrieval` mixes KB and memory items in one `retrievalResponse`
Distinguish by `sourceRetriever.identifier` (== memoryId) or by the `_memory_*` metadata keys.
Memory items carry metadata only (`content` has `mimeType` but no `text`); KB items carry text.

### 3.4 Managed KB data source type
For a managed knowledge base every connector is `MANAGED_KNOWLEDGE_BASE_CONNECTOR`, and
`connectorParameters.type` picks the source (`S3`, `CUSTOM`, `GOOGLEDRIVE`, ...). `aclEnabled`
cannot be changed after the data source is created, so a data source created without ACLs
must be replaced. `CreateDataSource` is asynchronous (wait for `AVAILABLE`).

### 3.5 SDK version
Python 3.9 environments pinned to botocore 1.42.x lack `AgenticRetrieveStream` entirely. Use
Python 3.10 or later and boto3 1.43.72 or later.

### 3.6 The `memoryRetrieve` planning action is not guaranteed
In one run the planner called memory explicitly; the identical question via the UI answered from the
speculative-retrieval memory hit alone with no `memoryRetrieve` action. Both paths are documented;
don't expect a `memoryRetrieve` action in every personalized answer.

### 3.7 Time to first token ≈ total time
Response text arrived within ~100 ms of the result event in all runs, so generation was not streamed
progressively over seconds. Expect the answer text to arrive close to the end of the call.

## 4. Extending the sample

* **API Gateway + Lambda**: `backend/app.py` is a drop-in for a JWT-authorizer + Lambda pair; the claims
  arrive in `requestContext.authorizer.jwt.claims`. Lambda response streaming or WebSocket for SSE.
* **Enterprise IdP**: Cognito federating to Okta / Entra ID; `sub` remains the actorId. IAM Identity
  Center trusted identity propagation is *not* a supported path for Bedrock KB / AgentCore (checked).
* **Defense in depth with ABAC** (§1 #9, the default in the backend): per-user `AssumeRole`
  with `sts:TagSession` `userId=<sub>` and `SourceIdentity=<sub>`, condition keys on the memory statements,
  and a trust policy that accepts only the backend's principal and requires both markers in Cognito `sub`
  form. IAM refuses a mis-scoped actorId or namespace even if application code is wrong. The backend still
  chooses the tag, so this does not protect against the backend principal itself (README, Security).
  Also `bedrock-agentcore:namespaceVariable/<key>` exists for write-path tenant isolation if you add custom
  namespace variables.
* **Crawled ACLs**: SharePoint, OneDrive, Google Drive (service account + domain-wide delegation),
  Confluence, Box, Zendesk, Salesforce, ServiceNow crawl permissions and add a real-time check. Same
  `userContext.userId` (email). Not exercised here: it needs a real tenant in the source system.
* **Guardrails**: `policyConfiguration.bedrockGuardrailConfiguration` (BLOCK only) is rejected with
  `foundationModelType: MANAGED`; it needs `CUSTOM`, plus `bedrock:GetInferenceProfile`,
  `bedrock:InvokeModelWithResponseStream`, `bedrock:ApplyGuardrail`, and `bedrock:GetGuardrail` on the app
  role. In our testing a guardrail filtered the question and the knowledge base passages, but not restored
  session history, long-term memory records, or the generated answer.
* **CMK**: `encryptionKeyArn` on `CreateMemory` + `kms:Decrypt` for the app role.
* **Metadata filters on memory**: `retrievalConfigs[0].metadataFilters` (≤5) for records tagged by your
  own writers; `strategyId` to pin the planner to one strategy.
* **Data lifecycle**: `eventExpiryDuration`; `DeleteEvent` / `DeleteMemoryRecord` for a user-deletion
  workflow; `ListSessions` for a "your conversations" UI (already used here).
* **Observability**: log the trace with a correlation id (done in `backend/app.py`); CloudWatch metrics
  above; AgentCore observability view needs CloudWatch Transaction Search (not tested here).
* **Multi-KB routing**: retriever `description` drives routing when a request carries several knowledge
  bases (observed in an earlier two-KB version of this sample). The current sample uses one KB.

## 5. Not verified / open

* AgentCore Observability console view and spans for memory (needs Transaction Search enabled).
* Console support for `memoryConfiguration` in the "Test knowledge base" page.
* Pricing line for memory calls made by the service on the caller's behalf.
* Whether `AgenticRetrieveStream` and the memory calls it makes appear as CloudTrail data events, and with which user session ARN.
* Behaviour when the STM token budget is exceeded by a very long session (design says bounded; not exercised).
