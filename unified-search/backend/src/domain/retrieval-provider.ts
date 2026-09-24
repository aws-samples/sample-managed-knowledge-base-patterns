import type { ChatEvent, ChatRequest } from './chat.js';
import type { DocumentContent } from './documents.js';
import type { UserIdentity } from './identity.js';
import type { SearchPage, SearchQuery } from './search.js';
import type { KnowledgeSource } from './sources.js';

/**
 * Injection token for the configured {@link RetrievalProvider}.
 *
 * A string token rather than a class, because the port is an interface and
 * interfaces do not survive to runtime. Consumers inject the token; only the
 * application module knows which implementation is bound to it.
 */
export const RETRIEVAL_PROVIDER = 'RETRIEVAL_PROVIDER';

/**
 * What the configured provider can actually do.
 *
 * Reported rather than assumed, so the API and UI can degrade honestly instead of
 * offering a feature that silently does nothing. Conversation memory is optional
 * infrastructure: without it every question is answered independently, and a chat
 * UI should say so rather than appear to forget.
 */
export interface RetrievalCapabilities {
  /**
   * Whether {@link ChatRequest.conversationId} carries history across turns.
   *
   * False when no memory resource is configured. Chat still works; it is
   * single-turn.
   */
  readonly conversationMemory: boolean;
}

/**
 * The single seam between this application and whatever performs retrieval.
 *
 * Everything above this interface — controllers, the API contract, the frontend —
 * depends only on the domain types declared alongside it. The
 * implementation lives under `src/providers/`, which is the only directory
 * permitted to import the Bedrock SDK, enforced by ESLint and asserted in CI.
 *
 * ## Why identity is the first parameter
 *
 * Every retrieval method takes a {@link UserIdentity}, and it is **required**.
 * This is the most important design decision in the domain layer, so it is worth
 * stating plainly.
 *
 * Bedrock Managed Knowledge Base filters results by an identity supplied on the
 * request. Without one, ACL-enabled sources return no results (the secure
 * default), which is easy to mistake for an empty index during development.
 * Non-ACL sources return their documents to every user regardless of the
 * identity supplied, so passing the identity matters on every call, not only
 * where filtering happens to be visible.
 *
 * Making identity a required leading argument converts "forgot to pass the
 * user's identity" from a runtime behavior into a compile error. It is
 * deliberately not an optional parameter, not a field on an options object, and
 * not ambient request-scoped state — all three of which can be silently omitted.
 *
 * The same identity also partitions conversation memory. Memory holds generated
 * answers derived from documents the asking user was permitted to read, and
 * replaying memory is **not** ACL-filtered retrieval, so a shared or
 * caller-supplied partition key would bypass document access control without any
 * retrieval call to inspect. The provider derives that key from this identity.
 *
 * See SECURITY.md.
 */
export interface RetrievalProvider {
  readonly capabilities: RetrievalCapabilities;

  /**
   * Retrieve passages relevant to a query, filtered to what the user may read.
   *
   * @throws {AclEvaluationError} when access control could not be evaluated and
   * results are therefore incomplete. Distinct from an empty page.
   * @throws {InvalidQueryError} when the query or continuation token is rejected.
   */
  search(identity: UserIdentity, query: SearchQuery): Promise<SearchPage>;

  /**
   * Answer a question from the knowledge base, streaming the answer and the steps
   * taken to produce it.
   *
   * Streaming rather than a single result because the underlying agentic retrieval
   * is streaming-only, and buffering would discard both incremental answer text
   * and the trace of how the agent decomposed the question. Callers that need the
   * whole answer at once use {@link collectChat}.
   *
   * Errors surface by rejecting the iteration, so a `for await` inside a
   * `try`/`catch` behaves as expected.
   *
   * @throws {AclEvaluationError} when access control could not be evaluated.
   */
  chat(identity: UserIdentity, request: ChatRequest): AsyncIterable<ChatEvent>;

  /**
   * Fetch a document's content, if this user is permitted to read it.
   *
   * The identity is checked against the document's own access-control entries, so
   * this is the one place in the port where an access decision is made about a
   * *named resource* rather than a result set being filtered. That makes it the
   * easiest method here to get wrong: a search that forgets identity returns an
   * empty page and looks broken, whereas a document fetch that forgets identity
   * returns the document and looks like it works.
   *
   * @param documentId a document identifier from {@link SearchHit.id}.
   * @param dataSourceId from {@link SearchHit.dataSourceId}; the underlying
   * operation requires it alongside the document id.
   *
   * @throws {DocumentNotAvailableError} when the document does not exist **or**
   * this user may not read it — one error for both, so the API cannot be used to
   * discover which documents exist. See that type.
   */
  getDocument(
    identity: UserIdentity,
    documentId: string,
    dataSourceId: string,
  ): Promise<DocumentContent>;

  /**
   * List the data sources attached to the knowledge base.
   *
   * Takes no identity because it describes the knowledge base's configuration
   * rather than its contents, and returns no document data. Authorization for
   * this operation is the application's own concern — it reveals the shape of an
   * organization's corpus, so it should not be anonymous.
   */
  listSources(): Promise<readonly KnowledgeSource[]>;
}
