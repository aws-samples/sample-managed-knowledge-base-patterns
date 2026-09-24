import type { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { ListDataSourcesCommand } from '@aws-sdk/client-bedrock-agent';
import type { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import {
  AccessDeniedException,
  AgenticRetrieveStreamCommand,
  GetDocumentContentCommand,
  ResourceNotFoundException,
  RetrieveCommand,
  ValidationException,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ChatEvent } from '../../domain/index.js';
import {
  collectChat,
  DocumentNotAvailableError,
  InvalidQueryError,
  RetrievalError,
  SourceUnavailableError,
  UserIdentity,
} from '../../domain/index.js';
import type { BedrockProviderConfig } from './bedrock-config.js';
import { BedrockRetrievalProvider } from './bedrock-retrieval.provider.js';
import { stripCitationMarkers } from './answer-stream.js';

/**
 * Unit tests for the provider's request construction and response mapping.
 *
 * These do not prove that ACL filtering works — that is unfakeable, happens inside
 * Bedrock, and is asserted by `acl-filtering.integration.spec.ts` against a deployed
 * knowledge base. What they prove is the half that is ours: that the identity we
 * send is the verified one, that it is sent on every call, and that it is never
 * influenced by anything the caller supplied.
 */

const ALEJANDRO = UserIdentity.fromVerifiedClaims({
  email: 'Alejandro_Rosalez@Example.com',
  subject: 'sub-alejandro-1234',
});
const AKUA = UserIdentity.fromVerifiedClaims({
  email: 'akua_mansa@example.com',
  subject: 'sub-akua-5678',
});

const BASE_CONFIG: BedrockProviderConfig = {
  region: 'us-east-1',
  knowledgeBaseId: 'KB1234567',
  defaultMaxResults: 10,
  reranking: 'MANAGED',
};

/** Metadata in the shape the API returns on a `Retrieve` result: nine keys. */
const RETRIEVE_METADATA = {
  _file_type: 'PLAIN_TEXT',
  _document_title: 'q3-revenue-forecast.md',
  _source_uri: 'https://bucket.s3.amazonaws.com/content/finance/q3-revenue-forecast.md',
  _chunk_id: 'chunk-abc',
  _data_source_type: 'S3',
  _language_code: 'en',
  _created_at: '2025-01-01T00:00:00Z',
  _last_updated_at: '2025-01-01T00:00:00Z',
  _data_source_id: 'DS1111111',
};

/** Agentic results omit `documentId` and `location`, and add `_document_id`. */
const AGENTIC_METADATA = {
  ...RETRIEVE_METADATA,
  _document_id: 's3://bucket/content/finance/q3-revenue-forecast.md',
};

type SentCommand =
  | RetrieveCommand
  | AgenticRetrieveStreamCommand
  | ListDataSourcesCommand
  | GetDocumentContentCommand;

/**
 * Records every command sent and returns scripted responses.
 *
 * Hand-written rather than a mocking library: the assertions here are about the
 * exact shape of an outbound request carrying a user's identity, and reading that
 * off a recorded command is clearer than configuring a matcher.
 */
class FakeClient {
  readonly sent: SentCommand[] = [];
  private readonly responses: unknown[] = [];

  queue(response: unknown): void {
    this.responses.push(response);
  }

  send(command: SentCommand): Promise<unknown> {
    this.sent.push(command);
    const next = this.responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? {});
  }

  lastInput<T>(): T {
    const last = this.sent.at(-1);
    if (last === undefined) throw new Error('no command was sent');
    return last.input as T;
  }
}

/** Builds a provider over fake clients. */
function build(config: Partial<BedrockProviderConfig> = {}) {
  const runtime = new FakeClient();
  const control = new FakeClient();
  const provider = new BedrockRetrievalProvider(
    { ...BASE_CONFIG, ...config },
    runtime as unknown as BedrockAgentRuntimeClient,
    control as unknown as BedrockAgentClient,
  );
  return { provider, runtime, control };
}

/** Wraps events into the async iterable shape the SDK returns. */
function streamOf(events: readonly unknown[]): { stream: AsyncIterable<unknown> } {
  return {
    stream: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    },
  };
}

/**
 * Builds a realistic agentic stream: deltas carrying `[n]` markers, then a result
 * whose answer has them stripped, matching the shape `AgenticRetrieveStream` returns.
 */
function agenticStream(
  answerWithMarkers: string,
  options: {
    readonly results?: readonly unknown[];
    readonly citations?: readonly unknown[];
    readonly chunkSize?: number;
    readonly finalAnswer?: string;
  } = {},
) {
  const chunkSize = options.chunkSize ?? 7;
  const deltas: unknown[] = [];
  for (let i = 0; i < answerWithMarkers.length; i += chunkSize) {
    deltas.push({ responseEvent: { text: answerWithMarkers.slice(i, i + chunkSize) } });
  }

  return streamOf([
    {
      traceEvent: {
        attributes: {
          step: 'Retrieval',
          status: 'IN_PROGRESS',
          message: 'Starting retrieval for query: quarterly revenue forecast',
        },
      },
    },
    ...deltas,
    {
      result: {
        results: options.results ?? [],
        generatedResponse: {
          answer: options.finalAnswer ?? stripCitationMarkers(answerWithMarkers),
          ...(options.citations === undefined ? {} : { citations: options.citations }),
        },
      },
    },
  ]);
}

describe('BedrockRetrievalProvider', () => {
  describe('search', () => {
    it("sends the verified user's email as userContext.userId", async () => {
      const { provider, runtime } = build();
      runtime.queue({ retrievalResults: [] });

      await provider.search(ALEJANDRO, { text: 'revenue' });

      const input = runtime.lastInput<{ userContext?: { userId?: string } }>();
      // Normalized to lowercase by the domain, so every call uses a consistent
      // ACL join key.
      expect(input.userContext?.userId).toBe('alejandro_rosalez@example.com');
    });

    it('uses managedSearchConfiguration and never vectorSearchConfiguration', async () => {
      const { provider, runtime } = build();
      runtime.queue({ retrievalResults: [] });

      await provider.search(ALEJANDRO, { text: 'revenue', maxResults: 4 });

      const input = runtime.lastInput<{
        retrievalConfiguration?: Record<string, unknown>;
      }>();
      // Managed knowledge bases use managedSearchConfiguration;
      // vectorSearchConfiguration applies to vector-store knowledge bases.
      expect(input.retrievalConfiguration).not.toHaveProperty(
        'vectorSearchConfiguration',
      );
      expect(input.retrievalConfiguration?.managedSearchConfiguration).toMatchObject({
        numberOfResults: 4,
        rerankingModelType: 'MANAGED',
      });
    });

    it('falls back to the configured default result count', async () => {
      const { provider, runtime } = build({ defaultMaxResults: 25 });
      runtime.queue({ retrievalResults: [] });

      await provider.search(ALEJANDRO, { text: 'revenue' });

      const input = runtime.lastInput<{
        retrievalConfiguration?: {
          managedSearchConfiguration?: { numberOfResults?: number };
        };
      }>();
      expect(
        input.retrievalConfiguration?.managedSearchConfiguration?.numberOfResults,
      ).toBe(25);
    });

    it('maps a retrieval result onto a SearchHit', async () => {
      const { provider, runtime } = build();
      runtime.queue({
        retrievalResults: [
          {
            content: { type: 'TEXT', text: 'Projected Q3 revenue is $4.2 million.' },
            location: {
              type: 'S3',
              s3Location: { uri: RETRIEVE_METADATA._source_uri },
            },
            score: 0.36,
            metadata: RETRIEVE_METADATA,
            documentId: 's3://bucket/content/finance/q3-revenue-forecast.md',
          },
        ],
      });

      const page = await provider.search(ALEJANDRO, { text: 'revenue' });

      expect(page.hits).toHaveLength(1);
      expect(page.hits[0]).toMatchObject({
        // The `s3://` form, which is what the ACL debugging operations require.
        id: 's3://bucket/content/finance/q3-revenue-forecast.md',
        title: 'q3-revenue-forecast.md',
        uri: RETRIEVE_METADATA._source_uri,
        snippet: 'Projected Q3 revenue is $4.2 million.',
        score: 0.36,
        sourceType: 's3',
      });
      expect(page.hits[0]?.metadata._data_source_id).toBe('DS1111111');
    });

    it('reports an absent nextToken as an absent nextToken', async () => {
      const { provider, runtime } = build();
      runtime.queue({ retrievalResults: [] });

      const page = await provider.search(ALEJANDRO, { text: 'revenue' });

      expect(page.nextToken).toBeUndefined();
    });

    it('passes a continuation token through and returns one when given', async () => {
      const { provider, runtime } = build();
      runtime.queue({ retrievalResults: [], nextToken: 'token-2' });

      const page = await provider.search(ALEJANDRO, {
        text: 'revenue',
        nextToken: 'token-1',
      });

      expect(runtime.lastInput<{ nextToken?: string }>().nextToken).toBe('token-1');
      expect(page.nextToken).toBe('token-2');
    });

    it('scopes a single source with equals and several with in', async () => {
      const { provider, runtime } = build();

      runtime.queue({ retrievalResults: [] });
      await provider.search(ALEJANDRO, { text: 'x', sourceIds: ['DS1'] });
      expect(
        runtime.lastInput<{
          retrievalConfiguration?: {
            managedSearchConfiguration?: { filter?: unknown };
          };
        }>().retrievalConfiguration?.managedSearchConfiguration?.filter,
      ).toEqual({ equals: { key: '_data_source_id', value: 'DS1' } });

      runtime.queue({ retrievalResults: [] });
      await provider.search(ALEJANDRO, { text: 'x', sourceIds: ['DS1', 'DS2'] });
      expect(
        runtime.lastInput<{
          retrievalConfiguration?: {
            managedSearchConfiguration?: { filter?: unknown };
          };
        }>().retrievalConfiguration?.managedSearchConfiguration?.filter,
      ).toEqual({ in: { key: '_data_source_id', value: ['DS1', 'DS2'] } });
    });

    it('sends no filter when no sources are named', async () => {
      const { provider, runtime } = build();
      runtime.queue({ retrievalResults: [] });

      await provider.search(ALEJANDRO, { text: 'x', sourceIds: [] });

      expect(
        runtime.lastInput<{
          retrievalConfiguration?: {
            managedSearchConfiguration?: Record<string, unknown>;
          };
        }>().retrievalConfiguration?.managedSearchConfiguration,
      ).not.toHaveProperty('filter');
    });

    it('translates a validation failure into a domain error', async () => {
      const { provider, runtime } = build();
      runtime.queue(
        new ValidationException({ message: 'Text input is required.', $metadata: {} }),
      );

      // Rejects rather than throwing synchronously: every real failure arrives as a
      // rejected promise, so a synchronous throw would be invisible to `.catch()`.
      await expect(provider.search(ALEJANDRO, { text: '' })).rejects.toBeInstanceOf(
        InvalidQueryError,
      );
    });
  });

  describe('chat', () => {
    it('sends the verified email as userContext.userId', async () => {
      const { provider, runtime } = build();
      runtime.queue(agenticStream('Answer [1].'));

      await collectChat(provider.chat(ALEJANDRO, { message: 'revenue?' }));

      expect(
        runtime.lastInput<{ userContext?: { userId?: string } }>().userContext?.userId,
      ).toBe('alejandro_rosalez@example.com');
    });

    it('sends only the current user turn, never an assistant turn', async () => {
      const { provider, runtime } = build();
      runtime.queue(agenticStream('Answer [1].'));

      await collectChat(provider.chat(ALEJANDRO, { message: 'revenue?' }));

      const input = runtime.lastInput<{
        messages?: readonly { role?: string; content?: { text?: string } }[];
      }>();
      // The API accepts caller-supplied assistant turns; accepting them would mean
      // taking model-context content from the client and round-tripping content
      // derived from restricted documents through the browser.
      expect(input.messages).toEqual([{ role: 'user', content: { text: 'revenue?' } }]);
    });

    it('always sends agenticRetrieveConfiguration, which the API requires', async () => {
      const { provider, runtime } = build();
      runtime.queue(agenticStream('Answer.'));

      await collectChat(provider.chat(ALEJANDRO, { message: 'q' }));

      expect(
        runtime.lastInput<{ agenticRetrieveConfiguration?: unknown }>()
          .agenticRetrieveConfiguration,
      ).toEqual({});
    });

    it('streams answer text whose concatenation equals the final answer', async () => {
      const { provider, runtime } = build();
      const withMarkers =
        'Revenue is **$4.2 million** [1], up 11% [2].\n\n## Detail\nSubscriptions are $3.1m [1].';
      runtime.queue(agenticStream(withMarkers, { chunkSize: 3 }));

      const events: ChatEvent[] = [];
      for await (const event of provider.chat(ALEJANDRO, { message: 'q' }))
        events.push(event);

      const streamed = events
        .filter(
          (event): event is { kind: 'answer'; text: string } => event.kind === 'answer',
        )
        .map((event) => event.text)
        .join('');

      // This is the property the whole answer-stream module exists to provide, and
      // the one the citation spans depend on.
      expect(streamed).toBe(stripCitationMarkers(withMarkers));
      expect(streamed).not.toContain('[1]');
    });

    it('emits citations whose spans select the intended text', async () => {
      const { provider, runtime } = build();
      const withMarkers = 'Revenue is $4.2 million [1]. Growth was 11% [1].';
      const finalAnswer = stripCitationMarkers(withMarkers);
      const claim = 'Revenue is $4.2 million.';

      runtime.queue(
        agenticStream(withMarkers, {
          results: [
            { content: { text: 'Q3 revenue: $4.2m' }, metadata: AGENTIC_METADATA },
          ],
          citations: [
            { startIndex: 0, endIndex: claim.length, references: [{ resultIndex: 0 }] },
          ],
        }),
      );

      const turn = await collectChat(provider.chat(ALEJANDRO, { message: 'q' }));

      expect(turn.answer).toBe(finalAnswer);
      expect(turn.citations).toHaveLength(1);
      const citation = turn.citations[0]!;
      expect(citation.text).toBe(claim);
      // Spans must be valid against the text the caller actually received.
      expect(turn.answer.slice(citation.span.start, citation.span.end)).toBe(claim);
      expect(citation.references[0]).toMatchObject({
        documentId: AGENTIC_METADATA._document_id,
        title: 'q3-revenue-forecast.md',
        sourceType: 's3',
      });
    });

    it('withholds citations when the streamed answer does not reconcile', async () => {
      const { provider, runtime } = build();
      // A final answer that is not the marker-stripped stream. If this ever happens
      // in reality, every span is suspect, and a citation pointing at the wrong
      // document is worse than no citation in a sample about provenance.
      runtime.queue(
        agenticStream('Streamed answer [1].', {
          finalAnswer: 'A completely different final answer.',
          results: [{ content: { text: 'src' }, metadata: AGENTIC_METADATA }],
          citations: [
            { startIndex: 0, endIndex: 10, references: [{ resultIndex: 0 }] },
          ],
        }),
      );

      const turn = await collectChat(provider.chat(ALEJANDRO, { message: 'q' }));

      expect(turn.citations).toEqual([]);
      expect(turn.traces.map((trace) => trace.label)).toContain('Citations withheld');
    });

    it('drops citation spans that fall outside the answer rather than clamping them', async () => {
      const { provider, runtime } = build();
      runtime.queue(
        agenticStream('Short answer.', {
          results: [{ content: { text: 'src' }, metadata: AGENTIC_METADATA }],
          citations: [
            { startIndex: 0, endIndex: 9_999, references: [{ resultIndex: 0 }] },
            { startIndex: 5, endIndex: 5, references: [{ resultIndex: 0 }] },
          ],
        }),
      );

      const turn = await collectChat(provider.chat(ALEJANDRO, { message: 'q' }));

      // Clamping would silently attribute the wrong text to a source.
      expect(turn.citations).toEqual([]);
    });

    it('surfaces the agent reasoning steps as traces', async () => {
      const { provider, runtime } = build();
      runtime.queue(agenticStream('Answer.'));

      const turn = await collectChat(provider.chat(ALEJANDRO, { message: 'q' }));

      expect(turn.traces).toEqual([
        {
          label: 'Retrieval',
          detail: 'Starting retrieval for query: quarterly revenue forecast',
        },
      ]);
    });

    it('marks a failed step as failed and includes its failure message', async () => {
      const { provider, runtime } = build();
      runtime.queue(
        streamOf([
          {
            traceEvent: {
              attributes: {
                step: 'Retrieval',
                status: 'FAILED',
                message: 'Retrieval failed',
                failures: [{ message: 'downstream timeout' }],
              },
            },
          },
          { result: { results: [], generatedResponse: { answer: '' } } },
        ]),
      );

      const turn = await collectChat(provider.chat(ALEJANDRO, { message: 'q' }));

      expect(turn.traces[0]).toEqual({
        label: 'Retrieval (failed)',
        detail: 'Retrieval failed — downstream timeout',
      });
    });

    it('maps retrieved passages onto sources', async () => {
      const { provider, runtime } = build();
      runtime.queue(
        agenticStream('Answer.', {
          results: [
            { content: { text: 'Q3 revenue: $4.2m' }, metadata: AGENTIC_METADATA },
          ],
        }),
      );

      const turn = await collectChat(provider.chat(ALEJANDRO, { message: 'q' }));

      expect(turn.sources).toHaveLength(1);
      expect(turn.sources[0]).toMatchObject({
        // Agentic results carry no top-level documentId, so this comes from the
        // tenth metadata key.
        id: AGENTIC_METADATA._document_id,
        uri: AGENTIC_METADATA._source_uri,
        sourceType: 's3',
      });
      // No score is reported on the agentic path; absent beats a defaulted 0, which
      // would sort as "least relevant" rather than "not ranked".
      expect(turn.sources[0]?.score).toBeUndefined();
    });

    it('raises an error delivered inside the stream', async () => {
      const { provider, runtime } = build();
      runtime.queue(
        streamOf([
          { responseEvent: { text: 'partial' } },
          {
            resourceNotFoundException: {
              name: 'ResourceNotFoundException',
              message: 'gone',
            },
          },
        ]),
      );

      // Errors arrive as union members inside the stream, not as a rejected send,
      // so a try/catch around the initial call alone would see a stream that simply
      // ended early.
      await expect(
        collectChat(provider.chat(ALEJANDRO, { message: 'q' })),
      ).rejects.toThrow();
    });
  });

  describe('conversation memory', () => {
    const WITH_MEMORY = { memory: { memoryId: 'mem-123' } };

    it('is reported as unavailable when no memory resource is configured', () => {
      expect(build().provider.capabilities.conversationMemory).toBe(false);
      expect(build(WITH_MEMORY).provider.capabilities.conversationMemory).toBe(true);
    });

    it('sends no memoryConfiguration when memory is not configured', async () => {
      const { provider, runtime } = build();
      runtime.queue(agenticStream('Answer.'));

      await collectChat(
        provider.chat(ALEJANDRO, { message: 'q', conversationId: 'conv-1' }),
      );

      expect(
        runtime.lastInput<{ memoryConfiguration?: unknown }>().memoryConfiguration,
      ).toBeUndefined();
    });

    it('derives actorId from the verified subject, not from the request', async () => {
      const { provider, runtime } = build(WITH_MEMORY);
      runtime.queue(agenticStream('Answer.'));

      await collectChat(
        provider.chat(ALEJANDRO, { message: 'q', conversationId: 'conv-1' }),
      );

      const input = runtime.lastInput<{
        memoryConfiguration?: {
          memoryId?: string;
          sessionBinding?: { actorId?: string; sessionId?: string };
          persistenceMode?: string;
        };
      }>();
      expect(input.memoryConfiguration).toEqual({
        memoryId: 'mem-123',
        sessionBinding: { actorId: 'sub-alejandro-1234', sessionId: 'conv-1' },
        persistenceMode: 'DEFAULT',
      });
    });

    it('gives two identities different actors for the same conversationId', async () => {
      const { provider, runtime } = build(WITH_MEMORY);

      runtime.queue(agenticStream('Answer.'));
      await collectChat(
        provider.chat(ALEJANDRO, { message: 'q', conversationId: 'shared' }),
      );
      const forAlejandro = runtime.lastInput<{
        memoryConfiguration?: { sessionBinding?: { actorId?: string } };
      }>().memoryConfiguration?.sessionBinding?.actorId;

      runtime.queue(agenticStream('Answer.'));
      await collectChat(
        provider.chat(AKUA, { message: 'q', conversationId: 'shared' }),
      );
      const forAkua = runtime.lastInput<{
        memoryConfiguration?: { sessionBinding?: { actorId?: string } };
      }>().memoryConfiguration?.sessionBinding?.actorId;

      // Memory holds generated answers derived from documents the asking user could
      // read, and replaying memory is not ACL-filtered retrieval. A shared actor
      // would leak restricted content with no retrieval call to inspect.
      expect(forAlejandro).toBe('sub-alejandro-1234');
      expect(forAkua).toBe('sub-akua-5678');
      expect(forAlejandro).not.toBe(forAkua);
    });

    /**
     * The attack this guards against: a caller putting another user's identifier in
     * the one memory field it controls, hoping it lands in `actorId`.
     */
    it('cannot be steered into another actor by a crafted conversationId', async () => {
      const { provider, runtime } = build(WITH_MEMORY);

      for (const conversationId of [
        // Akua's actual subject, in the one memory field a caller controls.
        'sub-akua-5678',
        'akua_mansa@example.com',
        // Traversal shapes, in case the session id were ever concatenated into a
        // namespace or key.
        '../sub-akua-5678',
        'conv-1/../../sub-akua-5678',
      ]) {
        runtime.queue(agenticStream('Answer.'));
        await collectChat(provider.chat(ALEJANDRO, { message: 'q', conversationId }));

        const memory = runtime.lastInput<{
          memoryConfiguration?: {
            sessionBinding?: { actorId?: string; sessionId?: string };
          };
        }>().memoryConfiguration;

        // Two acceptable outcomes, and the assertion covers both: the id is
        // rejected and no memory is attached, or it is accepted as a *session* id
        // under the caller's own verified actor. What must never happen is the
        // caller's string reaching `actorId`.
        //
        // Note that alejandro naming her session `sub-akua-5678` is harmless — a session
        // is scoped within an actor, so it addresses a partition of alejandro's own
        // memory that has nothing to do with akua. The actor is what isolates users,
        // which is exactly why the actor is the field a caller cannot influence.
        if (memory !== undefined) {
          expect(memory.sessionBinding?.actorId).toBe('sub-alejandro-1234');
        }
      }
    });

    it('rejects an unusable conversationId by starting a fresh conversation', async () => {
      const { provider, runtime } = build(WITH_MEMORY);

      for (const conversationId of [
        '',
        '   ',
        'has spaces',
        'a'.repeat(129),
        'semi;colon',
      ]) {
        runtime.queue(agenticStream('Answer.'));
        await collectChat(provider.chat(ALEJANDRO, { message: 'q', conversationId }));

        expect(
          runtime.lastInput<{ memoryConfiguration?: unknown }>().memoryConfiguration,
          `conversationId ${JSON.stringify(conversationId)}`,
        ).toBeUndefined();
      }
    });

    it('scopes a long-term memory namespace to the actor', async () => {
      const { provider, runtime } = build({
        memory: { memoryId: 'mem-123', longTermNamespace: 'facts/{actorId}/summaries' },
      });
      runtime.queue(agenticStream('Answer.'));

      await collectChat(
        provider.chat(ALEJANDRO, { message: 'q', conversationId: 'conv-1' }),
      );

      expect(
        runtime.lastInput<{
          memoryConfiguration?: {
            retrievalConfigs?: readonly { namespace?: string }[];
          };
        }>().memoryConfiguration?.retrievalConfigs,
      ).toEqual([{ namespace: 'facts/sub-alejandro-1234/summaries' }]);
    });
  });

  describe('listSources', () => {
    it('reports ACL filtering as unknown when the data source APIs do not return it', async () => {
      const { provider, control } = build();
      control.queue({
        dataSourceSummaries: [
          { dataSourceId: 'DS1', name: 'sample-s3-content', status: 'AVAILABLE' },
        ],
      });

      const sources = await provider.listSources();

      // GetDataSource does not include connectorParameters, where `aclEnabled` is
      // set. Reporting `false` would assert the source is unfiltered, which the
      // provider cannot confirm either.
      expect(sources).toEqual([
        {
          id: 'DS1',
          name: 'sample-s3-content',
          aclFiltering: 'unknown',
          type: 'unknown',
        },
      ]);
    });

    it('follows pagination', async () => {
      const { provider, control } = build();
      control.queue({
        dataSourceSummaries: [{ dataSourceId: 'DS1', name: 'one' }],
        nextToken: 'page-2',
      });
      control.queue({ dataSourceSummaries: [{ dataSourceId: 'DS2', name: 'two' }] });

      const sources = await provider.listSources();

      expect(sources.map((source) => source.id)).toEqual(['DS1', 'DS2']);
      expect(control.sent).toHaveLength(2);
      expect(control.sent[1]?.input).toMatchObject({ nextToken: 'page-2' });
    });

    it('falls back to the id when a source has no name', async () => {
      const { provider, control } = build();
      control.queue({ dataSourceSummaries: [{ dataSourceId: 'DS1' }] });

      expect((await provider.listSources())[0]?.name).toBe('DS1');
    });

    it('translates a control plane failure into a domain error', async () => {
      const { provider, control } = build();
      control.queue(
        new ResourceNotFoundException({
          message: 'no such knowledge base',
          $metadata: {},
        }),
      );

      // Nothing above the provider boundary should ever see an SDK exception class.
      await expect(provider.listSources()).rejects.toBeInstanceOf(
        SourceUnavailableError,
      );
    });
  });

  describe('getDocument', () => {
    const DOC = 's3://bucket/content/finance/q3-revenue-forecast.md';
    const OK = {
      mimeType: 'text/plain',
      presignedUrl: 'https://content.example.com/signed?X-Amz-Expires=300',
      documentContentLength: 706,
    };

    it('sends the verified identity as the userContext', async () => {
      const { provider, runtime } = build();
      runtime.queue(OK);

      await provider.getDocument(ALEJANDRO, DOC, 'DS1');

      expect(runtime.lastInput()).toMatchObject({
        knowledgeBaseId: 'KB1234567',
        dataSourceId: 'DS1',
        documentId: DOC,
        outputFormat: 'RAW',
        // Normalized to lower case by UserIdentity, as everywhere else.
        userContext: { userId: 'alejandro_rosalez@example.com' },
      });
    });

    it('maps the response onto the domain type', async () => {
      const { provider, runtime } = build();
      runtime.queue(OK);

      expect(await provider.getDocument(ALEJANDRO, DOC, 'DS1')).toEqual({
        mimeType: 'text/plain',
        url: OK.presignedUrl,
        expiresInSeconds: 300,
        sizeBytes: 706,
      });
    });

    it('defaults the mime type rather than claiming text', async () => {
      const { provider, runtime } = build();
      runtime.queue({ presignedUrl: 'https://example.com/x' });

      const content = await provider.getDocument(ALEJANDRO, DOC, 'DS1');

      // A caller deciding whether it can render this must not be told "text/plain"
      // on the strength of a missing field.
      expect(content.mimeType).toBe('application/octet-stream');
      expect(content.sizeBytes).toBeUndefined();
    });

    /**
     * The two failures a caller must not be able to tell apart.
     *
     * `GetDocumentContent` raises `AccessDeniedException` for a document the user may
     * not read and `ResourceNotFoundException` for one that does not exist, which suits
     * IAM-credentialed callers. This API relays on behalf of end users, so it reports
     * both identically and a user cannot infer which file names exist in a folder.
     */
    it.each([
      [
        'a denied document',
        new AccessDeniedException({
          message: 'You do not have permission to access this document.',
          $metadata: {},
        }),
      ],
      [
        'a document that does not exist',
        new ResourceNotFoundException({
          message: 'The document is not found.',
          $metadata: {},
        }),
      ],
    ])('reports %s identically', async (_label, sdkError) => {
      const { provider, runtime } = build();
      runtime.queue(sdkError);

      const error = await provider
        .getDocument(ALEJANDRO, DOC, 'DS1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DocumentNotAvailableError);
      expect((error as Error).message).toBe(
        'That document is not available. It may not exist, or you may not have ' +
          'permission to read it.',
      );
    });

    /**
     * `AccessDeniedException` means the end user here, not our task role.
     *
     * Everywhere else in this provider it means the opposite, and the shared error
     * mapper says so. If this case ever fell through to that mapper it would be
     * reported as a credentials problem, sending an operator to inspect an IAM policy
     * that is working — while telling the user the knowledge base is unreachable.
     */
    it('does not report a user denial as a credentials problem', async () => {
      const { provider, runtime } = build();
      runtime.queue(
        new AccessDeniedException({ message: 'no permission', $metadata: {} }),
      );

      const error = await provider
        .getDocument(ALEJANDRO, DOC, 'DS1')
        .catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(SourceUnavailableError);
      expect((error as Error).message).not.toMatch(/credential|task role|policy/i);
    });

    it('still translates other service exceptions', async () => {
      const { provider, runtime } = build();
      runtime.queue(
        new ValidationException({ message: 'bad document id', $metadata: {} }),
      );

      const error = await provider
        .getDocument(ALEJANDRO, DOC, 'DS1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InvalidQueryError);
    });

    it('fails rather than returning a document with no URL', async () => {
      const { provider, runtime } = build();
      // The service reported success but gave us nothing to fetch. Returning
      // `url: undefined` would push the contradiction into the UI.
      runtime.queue({ mimeType: 'text/plain' });

      const error = await provider
        .getDocument(ALEJANDRO, DOC, 'DS1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RetrievalError);
      expect(error).not.toBeInstanceOf(DocumentNotAvailableError);
    });
  });

  describe('the identity argument cannot be bypassed', () => {
    let runtime: FakeClient;
    let provider: BedrockRetrievalProvider;

    beforeEach(() => {
      const built = build({ memory: { memoryId: 'mem-123' } });
      runtime = built.runtime;
      provider = built.provider;
    });

    /**
     * Every outbound retrieval call must carry a user context. Without one,
     * ACL-enabled sources return no results (the secure default), which is easy to
     * mistake for an empty index during development.
     */
    it('sets userContext on every retrieval call', async () => {
      runtime.queue({ retrievalResults: [] });
      await provider.search(AKUA, { text: 'q' });

      runtime.queue(agenticStream('Answer.'));
      await collectChat(provider.chat(AKUA, { message: 'q', conversationId: 'c' }));

      // Document fetch included: it is the one call that makes an access decision
      // about a named document. GetDocumentContent requires a user context for
      // ACL-aware data sources; this code passes the verified identity explicitly
      // rather than relying on that validation.
      runtime.queue({ mimeType: 'text/plain', presignedUrl: 'https://example.com/x' });
      await provider.getDocument(AKUA, 's3://bucket/content/finance/q3.md', 'DS1');

      expect(runtime.sent).toHaveLength(3);
      for (const command of runtime.sent) {
        const input = command.input as { userContext?: { userId?: string } };
        expect(input.userContext?.userId).toBe('akua_mansa@example.com');
      }
    });

    it('never reads an identity out of the request payload', async () => {
      // `SearchQuery` and `ChatRequest` have no identity field by design. This
      // asserts that adding one to the wire payload changes nothing, which is what
      // stops a future controller from forwarding a client-supplied email.
      const smuggled = {
        text: 'q',
        message: 'q',
        userId: 'attacker@example.com',
        email: 'attacker@example.com',
        userContext: { userId: 'attacker@example.com' },
        actorId: 'sub-attacker',
      };

      runtime.queue({ retrievalResults: [] });
      await provider.search(ALEJANDRO, smuggled);

      runtime.queue(agenticStream('Answer.'));
      await collectChat(provider.chat(ALEJANDRO, { ...smuggled, conversationId: 'c' }));

      for (const command of runtime.sent) {
        const serialized = JSON.stringify(command.input);
        expect(serialized).not.toContain('attacker@example.com');
        expect(serialized).not.toContain('sub-attacker');
        expect(serialized).toContain('alejandro_rosalez@example.com');
      }
    });
  });
});
