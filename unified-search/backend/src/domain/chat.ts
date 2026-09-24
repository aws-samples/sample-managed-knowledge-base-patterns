import type { SearchHit } from './search.js';
import type { SourceType } from './sources.js';

export interface ChatRequest {
  readonly message: string;

  /**
   * Continues an existing conversation.
   *
   * Only meaningful when the provider reports
   * {@link RetrievalCapabilities.conversationMemory}. Without memory each
   * question is answered independently and this is ignored.
   *
   * Scoped *within* a user: the same string from two different identities refers
   * to two unrelated conversations. That isolation is the provider's
   * responsibility and is asserted by the integration suite.
   */
  readonly conversationId?: string;

  /** Restrict grounding to these data source IDs. See {@link SearchQuery.sourceIds}. */
  readonly sourceIds?: readonly string[];
}

/**
 * Character range within the generated answer that a citation supports.
 *
 * Offsets index into the concatenation of all `answer` events.
 */
export interface CitationSpan {
  readonly start: number;
  readonly end: number;
}

/** A source passage backing part of an answer. */
export interface CitationReference {
  readonly snippet: string;
  readonly uri?: string;
  readonly title?: string;
  readonly documentId?: string;

  /**
   * Data source that produced the passage.
   *
   * Present for the same reason it is on {@link SearchHit}: fetching a document's content
   * requires it alongside the document id, so without it a citation can name a document
   * but cannot open it. A citation that cannot be followed is most of the way to no
   * citation at all.
   */
  readonly dataSourceId?: string;

  readonly sourceType: SourceType;
}

/**
 * A claim in the generated answer, tied to the passages that support it.
 *
 * Close to what the underlying API returns, which is deliberate: keeping the
 * domain shape close to the API's citation model keeps the provider mapping thin,
 * while the type itself still carries no SDK import.
 */
export interface Citation {
  readonly span: CitationSpan;

  /** The answer text this citation covers. */
  readonly text: string;

  readonly references: readonly CitationReference[];
}

/**
 * One step the agent took while answering.
 *
 * Agentic retrieval decomposes a question into sub-queries and retrieves
 * iteratively, and it reports that work as it happens. Surfacing it is most of the
 * value on a multi-hop question: it is how a user sees *why* an answer was
 * assembled the way it was, rather than being handed a paragraph and asked to
 * trust it.
 */
export interface ChatTrace {
  /** Short label for the step, e.g. a sub-query the agent decided to run. */
  readonly label: string;
  readonly detail?: string;
}

/**
 * Events emitted while answering a question.
 *
 * A discriminated union rather than a callback bag, so exhaustiveness is checked
 * and a new event kind is a compile error at every consumer rather than something
 * silently dropped.
 */
export type ChatEvent =
  /** Incremental answer text. Concatenate in arrival order. */
  | { readonly kind: 'answer'; readonly text: string }
  /** A step the agent took. May arrive several times, may not arrive at all. */
  | { readonly kind: 'trace'; readonly trace: ChatTrace }
  /** Passages the answer was grounded in. */
  | { readonly kind: 'sources'; readonly hits: readonly SearchHit[] }
  /** Final citations, once the answer is complete. */
  | { readonly kind: 'citations'; readonly citations: readonly Citation[] };

/**
 * A completed answer.
 *
 * Not what {@link RetrievalProvider.chat} returns — it streams {@link ChatEvent}.
 * This is the aggregate form, for callers that need the whole answer
 * before doing anything, such as a batch evaluator or a test. {@link collectChat}
 * builds it from a stream.
 */
export interface ChatTurn {
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly sources: readonly SearchHit[];
  readonly traces: readonly ChatTrace[];
}

/**
 * Drains a chat stream into a {@link ChatTurn}.
 *
 * Provided here rather than in each caller so that "concatenate the answer deltas
 * in order" has exactly one implementation. Getting that wrong produces subtly
 * corrupted text and misaligned citation spans, since spans index into the
 * concatenated answer.
 */
export async function collectChat(events: AsyncIterable<ChatEvent>): Promise<ChatTurn> {
  let answer = '';
  const citations: Citation[] = [];
  const sources: SearchHit[] = [];
  const traces: ChatTrace[] = [];

  for await (const event of events) {
    switch (event.kind) {
      case 'answer':
        answer += event.text;
        break;
      case 'trace':
        traces.push(event.trace);
        break;
      case 'sources':
        sources.push(...event.hits);
        break;
      case 'citations':
        citations.push(...event.citations);
        break;
    }
  }

  return { answer, citations, sources, traces };
}
