import {
  BedrockAgentClient,
  ListDataSourcesCommand,
} from '@aws-sdk/client-bedrock-agent';
import {
  AccessDeniedException,
  AgenticRetrieveStreamCommand,
  BedrockAgentRuntimeClient,
  GetDocumentContentCommand,
  ResourceNotFoundException,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type {
  AgenticRetrieveMemoryConfiguration,
  AgenticRetrieveResultItem,
  AgenticRetrieveStreamResponseOutput,
  AgenticRetrieveTraceEvent,
  RetrievalFilter,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { Inject, Injectable, Logger } from '@nestjs/common';

import type {
  ChatEvent,
  ChatRequest,
  Citation,
  CitationReference,
  DocumentContent,
  KnowledgeSource,
  RetrievalCapabilities,
  RetrievalProvider,
  SearchHit,
  SearchPage,
  SearchQuery,
  UserIdentity,
} from '../../domain/index.js';
import { DocumentNotAvailableError, RetrievalError } from '../../domain/index.js';
import { AnswerNormalizer } from './answer-stream.js';
import type { BedrockProviderConfig } from './bedrock-config.js';
import { BEDROCK_PROVIDER_CONFIG, MEMORY_ACTOR_PLACEHOLDER } from './bedrock-config.js';
import { toDomainError } from './error-mapping.js';
import {
  agenticResultToSearchHit,
  METADATA_KEYS,
  toSearchHit,
} from './result-mapping.js';

/**
 * Lifetime of a `GetDocumentContent` URL.
 *
 * Not configurable, because the service sets it and this is only reporting it: the
 * API documents five minutes and the returned URL carries `X-Amz-Expires=300`. Named
 * here so the value that reaches a caller has a stated source rather than appearing
 * as a bare `300`.
 */
const PRESIGNED_URL_TTL_SECONDS = 300;

/**
 * {@link RetrievalProvider} backed by Amazon Bedrock Managed Knowledge Base.
 *
 * ## The security property this class is responsible for
 *
 * Identity is a shared responsibility. Bedrock Managed Knowledge Base applies
 * document ACLs for the user identity the calling application supplies;
 * authenticating that user is the application's responsibility. The boundary where
 * a verified identity becomes a request field therefore lives here, in this
 * process.
 *
 * Two request fields carry identity, and both are derived **only** from the
 * {@link UserIdentity} argument, which the token verifier is the only thing able to
 * construct:
 *
 * - `userContext.userId` — filters retrieval to documents the user may read.
 * - `memoryConfiguration.sessionBinding.actorId` — partitions conversation memory.
 *
 * The second is the sharper of the two. Memory holds *generated answers*, derived
 * from documents the asking user was permitted to read, and replaying memory is not
 * ACL-filtered retrieval — the ACL machinery never sees it. A caller-supplied or
 * shared `actorId` would therefore leak the substance of restricted documents with
 * no retrieval call for any diagnostic to catch. A retrieval bug returns a
 * document; a memory bug returns a summary of documents with no trace back to the
 * ACL that should have prevented it.
 *
 * `conversationId` from the request is used as `sessionId`, which is safe because a
 * session is scoped *within* an actor — but it is validated rather than trusted.
 *
 * See SECURITY.md and DESIGN.md.
 */
@Injectable()
export class BedrockRetrievalProvider implements RetrievalProvider {
  private readonly logger = new Logger(BedrockRetrievalProvider.name);

  readonly capabilities: RetrievalCapabilities;

  constructor(
    @Inject(BEDROCK_PROVIDER_CONFIG) private readonly config: BedrockProviderConfig,
    private readonly runtime: BedrockAgentRuntimeClient,
    private readonly control: BedrockAgentClient,
  ) {
    this.capabilities = { conversationMemory: config.memory !== undefined };
  }

  async search(identity: UserIdentity, query: SearchQuery): Promise<SearchPage> {
    const filter = buildSourceFilter(query.sourceIds);

    try {
      const response = await this.runtime.send(
        new RetrieveCommand({
          knowledgeBaseId: this.config.knowledgeBaseId,
          retrievalQuery: { text: query.text },
          // The identity, and the reason any of this filters at all.
          userContext: { userId: identity.email },
          retrievalConfiguration: {
            // Managed knowledge bases use `managedSearchConfiguration`;
            // `vectorSearchConfiguration` applies to vector-store knowledge bases.
            managedSearchConfiguration: {
              numberOfResults: query.maxResults ?? this.config.defaultMaxResults,
              rerankingModelType: this.config.reranking,
              ...(filter === undefined ? {} : { filter }),
            },
          },
          ...(query.nextToken === undefined ? {} : { nextToken: query.nextToken }),
        }),
      );

      const hits = (response.retrievalResults ?? []).map(toSearchHit);

      return {
        hits,
        // Passed through when present, so callers can request the next page.
        ...(response.nextToken === undefined ? {} : { nextToken: response.nextToken }),
      };
    } catch (error) {
      throw toDomainError(error, 'Retrieve');
    }
  }

  /**
   * Answers a question, streaming the answer and the agent's reasoning steps.
   *
   * An async generator rather than a buffered result, because `AgenticRetrieveStream`
   * is streaming-only and buffering would discard both incremental text and the
   * trace of how the question was decomposed. On a multi-hop question that trace is
   * most of the value.
   */
  async *chat(identity: UserIdentity, request: ChatRequest): AsyncIterable<ChatEvent> {
    const filter = buildSourceFilter(request.sourceIds);
    const normalizer = new AnswerNormalizer();

    let stream: AsyncIterable<AgenticRetrieveStreamResponseOutput> = EMPTY_STREAM;
    try {
      const response = await this.runtime.send(
        new AgenticRetrieveStreamCommand({
          // Only ever the current user turn. History comes from AgentCore Memory,
          // never from the caller. The API supports caller-supplied `assistant`
          // turns for applications that manage their own history; this API
          // deliberately doesn't expose that, because it would mean taking
          // model-context content from the client and round-tripping content
          // derived from restricted documents through the browser.
          messages: [{ role: 'user', content: { text: request.message } }],
          retrievers: [
            {
              configuration: {
                knowledgeBase: {
                  knowledgeBaseId: this.config.knowledgeBaseId,
                  ...(filter === undefined ? {} : { retrievalOverrides: { filter } }),
                },
              },
            },
          ],
          // Required parameter; an empty object selects the default agentic
          // retrieval settings.
          agenticRetrieveConfiguration: {},
          userContext: { userId: identity.email },
          // Set explicitly, so the request states that a generated answer is
          // expected rather than relying on the default.
          generateResponse: true,
          ...(this.memoryConfiguration(identity, request) ?? {}),
        }),
      );
      if (response.stream !== undefined) stream = response.stream;
    } catch (error) {
      throw toDomainError(error, 'AgenticRetrieveStream');
    }

    let finalAnswer: string | undefined;
    let citations: readonly Citation[] = [];
    let sources: readonly SearchHit[] = [];

    try {
      for await (const event of stream) {
        throwIfErrorEvent(event, 'AgenticRetrieveStream');

        if (event.traceEvent !== undefined) {
          const trace = toChatTrace(event.traceEvent);
          if (trace !== undefined) yield { kind: 'trace', trace };
          continue;
        }

        if (event.responseEvent?.text !== undefined) {
          // Normalized, not raw: the deltas carry inline `[n]` markers that the
          // final answer does not, and citation offsets index into the final
          // answer. See answer-stream.ts.
          const text = normalizer.push(event.responseEvent.text);
          if (text.length > 0) yield { kind: 'answer', text };
          continue;
        }

        if (event.result !== undefined) {
          finalAnswer = event.result.generatedResponse?.answer;
          const results = event.result.results ?? [];
          sources = results.map(agenticResultToSearchHit);
          citations = toCitations(
            event.result.generatedResponse?.citations,
            results,
            finalAnswer,
          );
        }
      }
    } catch (error) {
      throw toDomainError(error, 'AgenticRetrieveStream');
    }

    const tail = normalizer.flush();
    if (tail.length > 0) yield { kind: 'answer', text: tail };

    if (sources.length > 0) yield { kind: 'sources', hits: sources };

    // Citation spans are absolute offsets into the final answer, and the normalizer
    // reproduces that string from the streamed deltas. If the two ever differ, the
    // offsets no longer line up with the text the user saw. In a sample whose
    // subject is knowing where an answer came from, a citation pointing at the
    // wrong text is worse than none, so the citations are withheld and the caller
    // is told.
    if (finalAnswer !== undefined && normalizer.text !== finalAnswer) {
      this.logger.warn(
        'Streamed answer did not reconcile with the final answer; withholding ' +
          `${String(citations.length)} citation(s). ` +
          `streamed=${String(normalizer.text.length)} chars, ` +
          `final=${String(finalAnswer.length)} chars.`,
      );
      yield {
        kind: 'trace',
        trace: {
          label: 'Citations withheld',
          detail: 'Citations are unavailable for this answer.',
        },
      };
      return;
    }

    if (citations.length > 0) yield { kind: 'citations', citations };
  }

  /**
   * Lists the data sources attached to the knowledge base.
   *
   * ## Why `aclFiltering` is reported as `unknown`
   *
   * The data source APIs do not return the ACL setting for managed connectors:
   * `GetDataSource` does not include `connectorParameters`, where `aclEnabled` is
   * set at deploy time. The same response reports the type as
   * `MANAGED_KNOWLEDGE_BASE_CONNECTOR` without naming the connector family behind
   * it, so that is reported as `unknown` too.
   *
   * The domain type is three-valued so that `unknown` is not flattened into the
   * claim "this source returns documents to everyone". Callers should treat
   * `unknown` as unfiltered when deciding whether to warn.
   *
   * To confirm filtering for a source, retrieve as a user who should be denied and
   * check the result, which is what the integration suite does.
   */
  async listSources(): Promise<readonly KnowledgeSource[]> {
    try {
      const sources: KnowledgeSource[] = [];
      let nextToken: string | undefined;

      // Paginated: a knowledge base can carry more data sources than one page
      // holds.
      do {
        const response = await this.control.send(
          new ListDataSourcesCommand({
            knowledgeBaseId: this.config.knowledgeBaseId,
            ...(nextToken === undefined ? {} : { nextToken }),
          }),
        );

        for (const summary of response.dataSourceSummaries ?? []) {
          if (summary.dataSourceId === undefined) continue;
          sources.push({
            id: summary.dataSourceId,
            name: summary.name ?? summary.dataSourceId,
            aclFiltering: 'unknown',
            type: 'unknown',
          });
        }

        nextToken = response.nextToken;
      } while (nextToken !== undefined);

      return sources;
    } catch (error) {
      throw toDomainError(error, 'ListDataSources');
    }
  }

  /**
   * Fetches a document's content as a short-lived pre-authorized URL.
   *
   * ## `AccessDeniedException` means something different here
   *
   * Everywhere else in this provider, `AccessDeniedException` concerns *this
   * service's* IAM credentials — an end user who lacks document access gets an empty
   * result set, never an error. `GetDocumentContent` makes an access decision about a
   * named document for the identity in `userContext`, so here
   * `AccessDeniedException` means the end user was denied.
   *
   * That is why this method does not simply hand every failure to
   * {@link toDomainError}, whose mapping would report a user's own permission denial
   * as a misconfigured task role and send an operator to inspect IAM.
   *
   * Denial and non-existence are collapsed into one
   * {@link DocumentNotAvailableError} — see that type for why, and DESIGN.md under
   * "Backend surface" for the reasoning behind the `404`.
   *
   * ## `userContext` is passed on every call
   *
   * `GetDocumentContent` requires a user context for ACL-aware data sources and
   * returns a `ValidationException` without one. This code passes the verified
   * identity explicitly on every call rather than relying on that validation.
   */
  async getDocument(
    identity: UserIdentity,
    documentId: string,
    dataSourceId: string,
  ): Promise<DocumentContent> {
    let response;
    try {
      response = await this.runtime.send(
        new GetDocumentContentCommand({
          knowledgeBaseId: this.config.knowledgeBaseId,
          dataSourceId,
          documentId,
          // RAW, not EXTRACTED: EXTRACTED returns the service's parse of the file as
          // JSON, which is useful for debugging ingestion but is not the document.
          outputFormat: 'RAW',
          // The access decision. Never from the request — see the class docblock.
          userContext: { userId: identity.email },
        }),
      );
    } catch (error) {
      if (
        error instanceof AccessDeniedException ||
        error instanceof ResourceNotFoundException
      ) {
        // Logged at the boundary because the distinction is useful to an operator
        // reading logs. Withholding it from the *caller* is the point, not
        // withholding it from ourselves.
        this.logger.warn(
          `GetDocumentContent denied for ${identity.toString()}: ${error.name}`,
        );
        throw new DocumentNotAvailableError(
          'That document is not available. It may not exist, or you may not have ' +
            'permission to read it.',
          { cause: error },
        );
      }
      throw toDomainError(error, 'GetDocumentContent');
    }

    if (response.presignedUrl === undefined) {
      throw new RetrievalError(
        'GetDocumentContent returned no URL for a document it reported as accessible.',
      );
    }

    return {
      mimeType: response.mimeType ?? 'application/octet-stream',
      url: response.presignedUrl,
      // Documented as five minutes; see PRESIGNED_URL_TTL_SECONDS. Stated in the
      // contract so a caller does not cache the URL.
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
      ...(response.documentContentLength === undefined
        ? {}
        : { sizeBytes: response.documentContentLength }),
    };
  }

  /**
   * Builds the memory configuration, or nothing when memory is not configured.
   *
   * The `actorId` is the verified subject — not the email. Both come from the same
   * verified token, but the subject is immutable whereas an email address can be
   * reassigned to a different person, and memory outlives a session. Keying stored
   * answers on a reassignable identifier would hand a new owner of an address the
   * previous owner's conversation history.
   */
  private memoryConfiguration(
    identity: UserIdentity,
    request: ChatRequest,
  ): { memoryConfiguration: AgenticRetrieveMemoryConfiguration } | undefined {
    const memory = this.config.memory;
    if (memory === undefined) return undefined;

    const sessionId = normalizeConversationId(request.conversationId);
    if (sessionId === undefined) return undefined;

    return {
      memoryConfiguration: {
        memoryId: memory.memoryId,
        sessionBinding: {
          // Never `request`. See the class comment.
          actorId: identity.subject,
          sessionId,
        },
        ...(memory.longTermNamespace === undefined
          ? {}
          : {
              retrievalConfigs: [
                {
                  namespace: memory.longTermNamespace.replaceAll(
                    MEMORY_ACTOR_PLACEHOLDER,
                    identity.subject,
                  ),
                },
              ],
            }),
        persistenceMode: 'DEFAULT',
      },
    };
  }
}

/**
 * Stand-in for a response that arrived with no stream.
 *
 * The SDK types `stream` as optional. Rather than branching on that at the consumer,
 * an empty async iterable makes "no stream" behave as "no events" — which yields an
 * empty answer instead of a crash.
 */
const EMPTY_STREAM: AsyncIterable<AgenticRetrieveStreamResponseOutput> = {
  [Symbol.asyncIterator]: () => ({
    next: () =>
      Promise.resolve({ done: true, value: undefined } as IteratorResult<
        AgenticRetrieveStreamResponseOutput,
        undefined
      >),
  }),
};

/**
 * Restricts retrieval to specific data sources.
 *
 * `_data_source_id` is the filterable metadata key. Managed knowledge bases support
 * a subset of filter operators, including `equals`, `notEquals`, `in`, `notIn`,
 * `listContains`, `greaterThan`, `andAll`, and `orAll`. This code uses only `equals`
 * and `in`.
 */
export function buildSourceFilter(
  sourceIds: readonly string[] | undefined,
): RetrievalFilter | undefined {
  const ids = (sourceIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0) return undefined;

  const [only] = ids;
  if (ids.length === 1 && only !== undefined) {
    return { equals: { key: METADATA_KEYS.dataSourceId, value: only } };
  }
  return { in: { key: METADATA_KEYS.dataSourceId, value: ids } };
}

/**
 * Validates a caller-supplied conversation identifier.
 *
 * A session is scoped within an actor, so a caller choosing its own session id
 * cannot reach another user's history — the actor is what enforces that, and the
 * actor is not caller-supplied. It is still validated rather than passed through:
 * it reaches an AWS API, and an unbounded caller-controlled string does not belong
 * in a request without a length and character check.
 *
 * Returns `undefined` for an absent or unusable id, which starts a fresh
 * conversation rather than failing the request.
 */
export function normalizeConversationId(
  conversationId: string | undefined,
): string | undefined {
  if (conversationId === undefined) return undefined;

  const trimmed = conversationId.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return undefined;

  return trimmed;
}

/**
 * Raises the error carried by a stream event, if it is an error event.
 *
 * Errors arrive *inside* the stream as union members rather than as a rejected
 * send, so a `try`/`catch` around the initial call alone would miss every one of
 * them and the stream would simply appear to end early.
 */
function throwIfErrorEvent(
  event: AgenticRetrieveStreamResponseOutput,
  operation: string,
): void {
  const error =
    event.validationException ??
    event.resourceNotFoundException ??
    event.accessDeniedException ??
    event.throttlingException ??
    event.serviceQuotaExceededException ??
    event.conflictException ??
    event.dependencyFailedException ??
    event.badGatewayException ??
    event.internalServerException;

  if (error !== undefined) throw toDomainError(error, operation);
}

/** Domain vocabulary for the agent's reasoning steps. */
const STEP_LABELS: Readonly<Record<string, string>> = {
  SpeculativeRetrieval: 'Initial retrieval',
  Planning: 'Planning',
  Retrieval: 'Retrieval',
  FullDocumentExpansion: 'Reading full document',
  SessionHistoryLoad: 'Loading conversation history',
};

/**
 * Maps a trace event to a domain {@link ChatTrace}.
 *
 * Every event is surfaced, including the `IN_PROGRESS` ones, because those are the
 * events that carry the sub-query text — `"Starting retrieval for query: finance
 * revenue projections Q3 Q4"` is precisely the detail that explains a multi-hop
 * answer. A failed step is labeled as failed so it is not read as completed work.
 */
function toChatTrace(
  event: AgenticRetrieveTraceEvent,
): { label: string; detail?: string } | undefined {
  const attributes = event.attributes;
  if (attributes === undefined) return undefined;

  const step = attributes.step ?? 'Step';
  const label = STEP_LABELS[step] ?? step;
  const failed = attributes.status === 'FAILED';
  const failures = (attributes.failures ?? [])
    .map((failure) => failure.message)
    .filter((message): message is string => message !== undefined);

  const detail = [attributes.message, ...failures]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' — ');

  return {
    label: failed ? `${label} (failed)` : label,
    ...(detail.length === 0 ? {} : { detail }),
  };
}

/**
 * Maps span-based agentic citations to domain citations.
 *
 * The references are indirect: each carries a `resultIndex` into the result array
 * rather than the document itself, so the results have to be in hand to resolve
 * them. Spans whose offsets fall outside the answer are dropped rather than
 * clamped — a clamped span silently points at the wrong text, which is the failure
 * this whole area is guarding against.
 */
function toCitations(
  citations:
    | readonly {
        startIndex?: number;
        endIndex?: number;
        references?: readonly { resultIndex?: number }[];
      }[]
    | undefined,
  results: readonly AgenticRetrieveResultItem[],
  answer: string | undefined,
): readonly Citation[] {
  if (citations === undefined || answer === undefined) return [];

  const mapped: Citation[] = [];

  for (const citation of citations) {
    const { startIndex: start, endIndex: end } = citation;
    if (start === undefined || end === undefined) continue;
    if (start < 0 || end > answer.length || start >= end) continue;

    const references: CitationReference[] = [];
    for (const reference of citation.references ?? []) {
      const index = reference.resultIndex;
      if (index === undefined) continue;
      const result = results[index];
      if (result === undefined) continue;

      const hit = agenticResultToSearchHit(result);
      references.push({
        snippet: hit.snippet,
        sourceType: hit.sourceType,
        ...(hit.uri === undefined ? {} : { uri: hit.uri }),
        ...(hit.title === undefined ? {} : { title: hit.title }),
        ...(hit.id === '' ? {} : { documentId: hit.id }),
        ...(hit.dataSourceId === undefined ? {} : { dataSourceId: hit.dataSourceId }),
      });
    }

    mapped.push({
      span: { start, end },
      text: answer.slice(start, end),
      references,
    });
  }

  return mapped;
}

/** Re-exported so the module can assert it is wired to something real. */
export { RetrievalError };
