import type { ChatEvent, ChatRequest, Citation } from '../chat.js';
import type { DocumentContent } from '../documents.js';
import {
  AclEvaluationError,
  DocumentNotAvailableError,
  InvalidQueryError,
} from '../errors.js';
import type { UserIdentity } from '../identity.js';
import type {
  RetrievalCapabilities,
  RetrievalProvider,
} from '../retrieval-provider.js';
import type { SearchHit, SearchPage, SearchQuery } from '../search.js';
import type { KnowledgeSource } from '../sources.js';

/**
 * A document in the fake corpus, plus the access rules that govern it.
 */
export interface FakeDocument {
  readonly hit: SearchHit;

  /** Data source this document belongs to, matched against `SearchQuery.sourceIds`. */
  readonly sourceId: string;

  /**
   * Emails permitted to read this document.
   *
   * An empty array means nobody, matching Bedrock's behavior for an ACL-enabled
   * source: a document with no access control entry is treated as restricted, not
   * public, and is not returned to anyone.
   */
  readonly allowedEmails: readonly string[];

  /** Emails explicitly denied. Deny overrides allow, as it does in Bedrock. */
  readonly deniedEmails?: readonly string[];
}

export interface InMemoryProviderOptions {
  readonly documents?: readonly FakeDocument[];
  readonly sources?: readonly KnowledgeSource[];

  /**
   * When set, every retrieval call rejects with {@link AclEvaluationError}.
   *
   * Exists so callers can be tested against the fail-closed path. Real ACL
   * evaluation failures are invisible in a happy-path test but change what the
   * user should be told, so the behavior needs to be reachable in tests.
   */
  readonly failAclEvaluation?: boolean;

  /** Hits per page. Defaults to returning everything in one page. */
  readonly pageSize?: number;

  /**
   * Whether this fake reports conversation memory support.
   *
   * Exists so callers can be tested against both the multi-turn and single-turn
   * paths, since memory is optional infrastructure and the UI degrades differently.
   */
  readonly conversationMemory?: boolean;
}

/**
 * An in-memory {@link RetrievalProvider} for tests.
 *
 * ## Not for production, and structurally prevented from reaching it
 *
 * This file lives under `domain/testing/`, and ESLint forbids importing anything
 * from that directory outside `*.spec.ts` files. CI asserts the restriction still
 * fires.
 *
 * Test doubles stay out of production code so fixture data never ships in the
 * production build. Enforcing that with a lint rule means it does not depend on
 * how clearly a fake is named.
 *
 * ## Fidelity
 *
 * The point of this fake is to reproduce the parts of Bedrock's ACL behavior
 * that callers must handle, so tests exercise the conditions a real provider
 * presents:
 *
 * - documents with no ACL entry are returned to nobody;
 * - deny overrides allow;
 * - a page may be shorter than `maxResults` without being the last page,
 *   because ACL filtering does not backfill.
 */
export class InMemoryRetrievalProvider implements RetrievalProvider {
  private readonly documents: readonly FakeDocument[];
  private readonly sources: readonly KnowledgeSource[];
  private readonly failAclEvaluation: boolean;
  private readonly pageSize: number | undefined;
  readonly capabilities: RetrievalCapabilities;

  constructor(options: InMemoryProviderOptions = {}) {
    this.documents = options.documents ?? [];
    this.sources = options.sources ?? [];
    this.failAclEvaluation = options.failAclEvaluation ?? false;
    this.pageSize = options.pageSize;
    this.capabilities = {
      conversationMemory: options.conversationMemory ?? false,
    };
  }

  /**
   * Note the `try`/`catch` converting a synchronous throw into a rejection.
   *
   * A real provider performs a network call, so every failure it produces
   * arrives as a rejected promise. Without this, an argument validation error
   * would throw synchronously out of a method whose signature promises a
   * `Promise`, and any caller written as `provider.search(...).catch(...)` would
   * miss it entirely — so tests against the fake would pass while the same code
   * failed against the real provider.
   */
  search(identity: UserIdentity, query: SearchQuery): Promise<SearchPage> {
    try {
      if (this.failAclEvaluation) {
        throw new AclEvaluationError('Simulated access control evaluation failure');
      }

      const offset = this.decodeToken(query.nextToken);
      const matching = this.documents
        .filter((doc) => this.isVisibleTo(doc, identity))
        .filter((doc) => this.matchesSource(doc, query.sourceIds))
        .filter((doc) => this.matchesText(doc, query.text));

      const size = query.maxResults ?? this.pageSize ?? matching.length;
      const window = matching.slice(offset, offset + size);
      const consumed = offset + window.length;

      return Promise.resolve({
        hits: window.map((doc) => doc.hit),
        ...(consumed < matching.length ? { nextToken: String(consumed) } : {}),
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Streams events in the same order and shape a real provider does.
   *
   * An async generator rather than a method returning a pre-built array, so that
   * callers are exercised against genuine asynchronous iteration — including the
   * case where iteration rejects partway through, which is how a real provider
   * reports a mid-stream failure.
   *
   * Answer text is emitted in several chunks on purpose. A fake that yields the
   * whole answer as one event would let a caller that mishandles concatenation
   * pass, and citation spans index into the concatenated answer, so that bug
   * misplaces every inline citation.
   */
  async *chat(identity: UserIdentity, request: ChatRequest): AsyncIterable<ChatEvent> {
    const page = await this.search(identity, {
      text: request.message,
      ...(request.sourceIds ? { sourceIds: request.sourceIds } : {}),
    });

    yield {
      kind: 'trace',
      trace: { label: 'retrieve', detail: `${page.hits.length} passage(s)` },
    };

    // Deliberately ungrounded when nothing is visible, rather than inventing an
    // answer. Callers need a path that exercises "no citations".
    if (page.hits.length === 0) {
      yield { kind: 'answer', text: 'No relevant information was found.' };
      yield { kind: 'citations', citations: [] };
      return;
    }

    yield { kind: 'sources', hits: page.hits };

    const citations: Citation[] = [];
    let cursor = 0;

    for (const [index, hit] of page.hits.entries()) {
      // A leading space between passages, matching how the answer is assembled,
      // so spans stay aligned with the emitted text.
      const prefix = index === 0 ? '' : ' ';
      const text = `${prefix}${hit.snippet}`;
      yield { kind: 'answer', text };

      const start = cursor + prefix.length;
      citations.push({
        span: { start, end: start + hit.snippet.length },
        text: hit.snippet,
        references: [
          {
            snippet: hit.snippet,
            sourceType: hit.sourceType,
            ...(hit.uri ? { uri: hit.uri } : {}),
            ...(hit.title ? { title: hit.title } : {}),
            documentId: hit.id,
          },
        ],
      });
      cursor += text.length;
    }

    yield { kind: 'citations', citations };
  }

  /**
   * Serves a fake document, applying the same ACL rules retrieval applies.
   *
   * The fidelity that matters: **a document invisible to this identity is
   * indistinguishable from one that does not exist**, because the real provider
   * collapses those two cases deliberately to avoid leaking which documents exist.
   * A fake that raised different errors for them would let a caller ship code
   * branching on a difference the real provider does not expose.
   *
   * The URL is a `data:` URI rather than an invented https one, so that a test which
   * accidentally fetches it gets the fake's own content instead of reaching the
   * network or silently succeeding against nothing.
   */
  getDocument(
    identity: UserIdentity,
    documentId: string,
    dataSourceId: string,
  ): Promise<DocumentContent> {
    try {
      if (this.failAclEvaluation) {
        throw new AclEvaluationError('Simulated access control evaluation failure');
      }

      const doc = this.documents.find(
        (candidate) =>
          candidate.hit.id === documentId &&
          candidate.sourceId === dataSourceId &&
          this.isVisibleTo(candidate, identity),
      );

      if (doc === undefined) {
        throw new DocumentNotAvailableError(
          'That document is not available. It may not exist, or you may not have ' +
            'permission to read it.',
        );
      }

      const body = doc.hit.snippet;
      return Promise.resolve({
        mimeType: 'text/plain',
        url: `data:text/plain;base64,${Buffer.from(body, 'utf8').toString('base64')}`,
        expiresInSeconds: 300,
        sizeBytes: Buffer.byteLength(body, 'utf8'),
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  listSources(): Promise<readonly KnowledgeSource[]> {
    return Promise.resolve(this.sources);
  }

  private isVisibleTo(doc: FakeDocument, identity: UserIdentity): boolean {
    if (doc.deniedEmails?.includes(identity.email)) {
      return false;
    }
    return doc.allowedEmails.includes(identity.email);
  }

  private matchesSource(doc: FakeDocument, sourceIds?: readonly string[]): boolean {
    if (sourceIds === undefined || sourceIds.length === 0) {
      return true;
    }
    return sourceIds.includes(doc.sourceId);
  }

  private matchesText(doc: FakeDocument, text: string): boolean {
    const needle = text.trim().toLowerCase();
    if (needle.length === 0) {
      return true;
    }
    const haystack = `${doc.hit.title ?? ''} ${doc.hit.snippet}`.toLowerCase();
    return haystack.includes(needle);
  }

  private decodeToken(token: string | undefined): number {
    if (token === undefined) {
      return 0;
    }
    const offset = Number.parseInt(token, 10);
    if (Number.isNaN(offset) || offset < 0) {
      throw new InvalidQueryError(`Unusable continuation token: ${token}`);
    }
    return offset;
  }
}
