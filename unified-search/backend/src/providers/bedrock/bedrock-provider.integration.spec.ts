import { randomBytes } from 'node:crypto';

import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ChatEvent, SearchHit } from '../../domain/index.js';
import {
  collectChat,
  DocumentNotAvailableError,
  UserIdentity,
} from '../../domain/index.js';
import type { BedrockProviderConfig } from './bedrock-config.js';
import { BedrockRetrievalProvider } from './bedrock-retrieval.provider.js';

/**
 * Exercises the real provider against a real knowledge base.
 *
 * Distinct from `acl-filtering.integration.spec.ts`, which calls the SDK directly to
 * prove the *service* filters. This one proves *our provider* preserves that
 * filtering and maps responses correctly — the unit suite can only check the shape
 * of requests we build against fakes we also wrote, which cannot catch a wrong
 * assumption shared by both.
 *
 * It also verifies, against the deployed service, the one property the unit tests
 * can only simulate: that the streamed answer reconciles with the final answer, and
 * therefore that citation spans select the text the caller actually received.
 *
 * ## Running it
 *
 *   make test-acl
 *
 * or directly, against a sample-mode deployment that has been seeded and ingested:
 *
 *   ACL_TEST_KNOWLEDGE_BASE_ID=<id> npm run test:integration \
 *     --workspace @unified-search/backend
 *
 * Skipped without that variable so the unit suite needs no credentials. A skipped
 * security test proves nothing, so run this against a deployed knowledge base
 * before any release.
 */

const KNOWLEDGE_BASE_ID = process.env.ACL_TEST_KNOWLEDGE_BASE_ID;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

/** Must match `infra/lib/seed-acl.ts`. */
const ALEJANDRO = UserIdentity.fromVerifiedClaims({
  email: 'alejandro_rosalez@example.com',
  subject: 'integration-subject-alejandro',
});
const AKUA = UserIdentity.fromVerifiedClaims({
  email: 'akua_mansa@example.com',
  subject: 'integration-subject-akua',
});
const OUTSIDER = UserIdentity.fromVerifiedClaims({
  email: 'john_stiles@example.com',
  subject: 'integration-subject-outsider',
});

const FINANCE_QUERY = 'what is the projected quarterly revenue forecast';
const SHARED_QUERY = 'how do expenses and time off work';

/** Figures that appear only in the finance document. */
const FINANCE_FIGURES = ['4.2 million', '3.1 million', '3.6 million'];

const describeIfDeployed = KNOWLEDGE_BASE_ID === undefined ? describe.skip : describe;

/** An AgentCore Memory resource ID, if one is deployed. */
const MEMORY_ID = process.env.MEMORY_ID;
const describeIfMemory =
  MEMORY_ID === undefined || MEMORY_ID === '' ? describe.skip : describe;

/**
 * A value the knowledge base cannot supply.
 *
 * Memory tests need a discriminator that can only have come from conversation
 * history. Anything retrievable from the corpus would produce false positives — see
 * the note on the memory suite below.
 */
function randomNonce(): string {
  return `RC-${randomBytes(6).toString('hex').toUpperCase()}`;
}

describeIfDeployed('BedrockRetrievalProvider (integration)', () => {
  let provider: BedrockRetrievalProvider;

  beforeAll(() => {
    const config: BedrockProviderConfig = {
      region: REGION,
      knowledgeBaseId: KNOWLEDGE_BASE_ID ?? '',
      defaultMaxResults: 10,
      reranking: 'MANAGED',
    };
    provider = new BedrockRetrievalProvider(
      config,
      new BedrockAgentRuntimeClient({ region: REGION }),
      new BedrockAgentClient({ region: REGION }),
    );
  });

  const inFinance = (hits: readonly SearchHit[]) =>
    hits.some((hit) => (hit.uri ?? hit.id).includes('/finance/'));

  describe('search', () => {
    it('returns the finance document to alejandro and withholds it from akua', async () => {
      const [forAlejandro, forAkua] = await Promise.all([
        provider.search(ALEJANDRO, { text: FINANCE_QUERY }),
        provider.search(AKUA, { text: FINANCE_QUERY }),
      ]);

      expect(
        inFinance(forAlejandro.hits),
        `alejandro: ${describeHits(forAlejandro.hits)}`,
      ).toBe(true);
      expect(inFinance(forAkua.hits), `akua: ${describeHits(forAkua.hits)}`).toBe(
        false,
      );
    });

    it('returns nothing to a user named in no ACL entry', async () => {
      const page = await provider.search(OUTSIDER, { text: SHARED_QUERY });

      expect(page.hits, describeHits(page.hits)).toEqual([]);
    });

    it('populates the mapped SearchHit fields from real responses', async () => {
      const page = await provider.search(ALEJANDRO, { text: FINANCE_QUERY });
      const [hit] = page.hits;

      expect(hit).toBeDefined();
      // The `s3://` form, which is what the ACL operations accept. The HTTPS
      // `_source_uri` is a display link, not a document identifier.
      expect(hit?.id).toMatch(/^s3:\/\//);
      expect(hit?.title).toMatch(/\.md$/);
      expect(hit?.uri).toMatch(/^https:\/\//);
      expect(hit?.snippet.length ?? 0).toBeGreaterThan(0);
      expect(hit?.sourceType).toBe('s3');
      expect(typeof hit?.score).toBe('number');
      // Nine service-owned metadata keys on the Retrieve path.
      expect(hit?.metadata).toHaveProperty('_data_source_id');
      expect(hit?.metadata).toHaveProperty('_document_title');
    });

    it('scopes results to a named data source, and returns none for an unknown one', async () => {
      const sources = await provider.listSources();
      const realId = sources[0]?.id;
      expect(realId).toBeDefined();

      const [scoped, bogus] = await Promise.all([
        provider.search(ALEJANDRO, { text: SHARED_QUERY, sourceIds: [realId ?? ''] }),
        provider.search(ALEJANDRO, { text: SHARED_QUERY, sourceIds: ['NOPENOPE00'] }),
      ]);

      expect(scoped.hits.length).toBeGreaterThan(0);
      expect(bogus.hits).toEqual([]);
    });

    it('does not let a metadata filter bypass access control', async () => {
      const sources = await provider.listSources();
      const realId = sources[0]?.id ?? '';

      // Same query, same filter, two identities. Filtering and authorization are
      // independent and composed, not alternatives.
      const [forAlejandro, forAkua] = await Promise.all([
        provider.search(ALEJANDRO, { text: FINANCE_QUERY, sourceIds: [realId] }),
        provider.search(AKUA, { text: FINANCE_QUERY, sourceIds: [realId] }),
      ]);

      expect(inFinance(forAlejandro.hits)).toBe(true);
      expect(inFinance(forAkua.hits), `akua: ${describeHits(forAkua.hits)}`).toBe(
        false,
      );
    });

    it('rejects an empty query as an invalid query', async () => {
      await expect(provider.search(ALEJANDRO, { text: '' })).rejects.toThrow();
    });
  });

  describe('chat', () => {
    it('streams an answer whose concatenation matches the final answer', async () => {
      const events = await drain(provider.chat(ALEJANDRO, { message: FINANCE_QUERY }));

      const answer = events
        .filter(
          (event): event is { kind: 'answer'; text: string } => event.kind === 'answer',
        )
        .map((event) => event.text)
        .join('');

      expect(answer.length).toBeGreaterThan(0);
      // The reconciliation property. If the provider's normalizer drifted from what
      // the service does, citations would be withheld — so their presence is itself
      // the assertion that the two strings agreed.
      expect(answer).not.toMatch(/\[\d+\]/);
      expect(events.map((event) => event.kind)).not.toContain('citations-withheld');
      const withheld = events.filter(
        (event) => event.kind === 'trace' && event.trace.label === 'Citations withheld',
      );
      expect(
        withheld,
        'citations were withheld, so the normalizer disagreed with the service',
      ).toEqual([]);
    });

    it('produces citations whose spans select real text from the answer', async () => {
      const turn = await collectChat(
        provider.chat(ALEJANDRO, { message: FINANCE_QUERY }),
      );

      expect(turn.citations.length).toBeGreaterThan(0);
      for (const citation of turn.citations) {
        expect(turn.answer.slice(citation.span.start, citation.span.end)).toBe(
          citation.text,
        );
        expect(citation.text.length).toBeGreaterThan(0);
      }
    });

    it('grounds the answer in retrievable sources', async () => {
      const turn = await collectChat(
        provider.chat(ALEJANDRO, { message: FINANCE_QUERY }),
      );

      expect(turn.sources.length).toBeGreaterThan(0);
      // Agentic results carry no top-level documentId; this comes from the tenth
      // metadata key, `_document_id`.
      expect(turn.sources[0]?.id).toMatch(/^s3:\/\//);
      expect(turn.sources[0]?.sourceType).toBe('s3');
    });

    it('reports the agent reasoning steps', async () => {
      const turn = await collectChat(
        provider.chat(ALEJANDRO, { message: FINANCE_QUERY }),
      );

      expect(turn.traces.length).toBeGreaterThan(0);
    });

    /**
     * The half that matters on the chat path. Retrieval filtering is proven
     * elsewhere; here a generator sits between the filtered documents and the user,
     * and a generator can say things the documents did not.
     */
    it('does not disclose restricted figures to a denied user', async () => {
      const turn = await collectChat(provider.chat(AKUA, { message: FINANCE_QUERY }));

      const leaked = FINANCE_FIGURES.filter((figure) => turn.answer.includes(figure));
      expect(
        leaked,
        `akua's answer leaked: ${leaked.join(', ')}\n${turn.answer}`,
      ).toEqual([]);
      expect(
        turn.sources.some((source) => (source.uri ?? source.id).includes('/finance/')),
        `akua was grounded in: ${describeHits(turn.sources)}`,
      ).toBe(false);
    });

    it('gives an authorized user the figures a denied user does not get', async () => {
      const turn = await collectChat(
        provider.chat(ALEJANDRO, { message: FINANCE_QUERY }),
      );

      // Guards against the denial test above passing vacuously — if nobody can see
      // the finance document, akua seeing nothing proves nothing.
      const present = FINANCE_FIGURES.filter((figure) => turn.answer.includes(figure));
      expect(present.length, `alejandro's answer: ${turn.answer}`).toBeGreaterThan(0);
    });

    it('reports conversationMemory as false when no memory is configured', () => {
      expect(provider.capabilities.conversationMemory).toBe(false);
    });
  });

  /**
   * Conversation memory, and the isolation property that makes it safe.
   *
   * Skipped unless `MEMORY_ID` names a deployed AgentCore Memory resource:
   *
   *   make test-acl MEMORY_ID=$(make -s sample-ids | awk '/MemoryId/ {print $2}')
   *
   * ## Why the discriminator is a nonce and not a fact from the corpus
   *
   * The obvious test — ask for the revenue figure, then check the next turn recalls
   * it — cannot tell memory from retrieval. Alejandro can retrieve that figure from
   * the knowledge base on any turn, including in a fresh session, so an answer
   * containing it proves nothing about memory.
   *
   * So the discriminator is a random code the user states and the corpus cannot
   * supply. If it appears in a later answer, it came from conversation history and
   * nowhere else.
   */
  describeIfMemory('conversation memory', () => {
    let memoryProvider: BedrockRetrievalProvider;

    beforeAll(() => {
      memoryProvider = new BedrockRetrievalProvider(
        {
          region: REGION,
          knowledgeBaseId: KNOWLEDGE_BASE_ID ?? '',
          defaultMaxResults: 10,
          reranking: 'MANAGED',
          memory: { memoryId: MEMORY_ID ?? '' },
        },
        new BedrockAgentRuntimeClient({ region: REGION }),
        new BedrockAgentClient({ region: REGION }),
      );
    });

    it('reports conversationMemory as available', () => {
      expect(memoryProvider.capabilities.conversationMemory).toBe(true);
    });

    it('carries history across turns within one identity', async () => {
      const nonce = randomNonce();
      const conversationId = `itest-recall-${nonce}`;

      await collectChat(
        memoryProvider.chat(ALEJANDRO, {
          message: `Please remember this reference code for later: ${nonce}.`,
          conversationId,
        }),
      );

      const second = await collectChat(
        memoryProvider.chat(ALEJANDRO, {
          message:
            'What reference code did I give you earlier? Answer from our conversation only.',
          conversationId,
        }),
      );

      expect(
        second.answer.includes(nonce),
        `alejandro did not recall her own code. answer: ${second.answer}`,
      ).toBe(true);
    });

    /**
     * The property the whole memory design exists to guarantee.
     *
     * Memory holds generated answers derived from documents the asking user was
     * permitted to read, and replaying memory is **not** ACL-filtered retrieval — the
     * access-control machinery never sees it. So if two identities sharing a
     * conversation id could see each other's history, document-level access control
     * would be bypassed invisibly, with no retrieval call for a diagnostic to catch.
     *
     * AgentCore Memory partitions history by the `actorId` the application supplies,
     * so the application must derive it from a verified identity. This provider takes
     * `actorId` from the verified token, with no code path from the request to it.
     */
    it('does not leak history between identities sharing a conversationId', async () => {
      const nonce = randomNonce();
      // Deliberately the same string for both users.
      const conversationId = `itest-isolation-${nonce}`;

      await collectChat(
        memoryProvider.chat(ALEJANDRO, {
          message: `Please remember this reference code for later: ${nonce}.`,
          conversationId,
        }),
      );

      const forAkua = await collectChat(
        memoryProvider.chat(AKUA, {
          message:
            'What reference code did I give you earlier? Answer from our conversation only.',
          conversationId,
        }),
      );

      expect(
        forAkua.answer.includes(nonce),
        `akua saw alejandro's history through a shared conversationId. answer: ${forAkua.answer}`,
      ).toBe(false);
    });

    it('starts a fresh conversation for a different conversationId', async () => {
      const nonce = randomNonce();

      await collectChat(
        memoryProvider.chat(ALEJANDRO, {
          message: `Please remember this reference code for later: ${nonce}.`,
          conversationId: `itest-first-${nonce}`,
        }),
      );

      const other = await collectChat(
        memoryProvider.chat(ALEJANDRO, {
          message:
            'What reference code did I give you earlier? Answer from our conversation only.',
          conversationId: `itest-second-${nonce}`,
        }),
      );

      expect(
        other.answer.includes(nonce),
        `history was shared across conversations. answer: ${other.answer}`,
      ).toBe(false);
    });

    it('loads session history as a reported step', async () => {
      const turn = await collectChat(
        memoryProvider.chat(ALEJANDRO, {
          message: 'Hello.',
          conversationId: `itest-trace-${randomNonce()}`,
        }),
      );

      // Surfacing this matters: it is how a user can tell that a multi-turn
      // conversation is carrying history forward.
      expect(turn.traces.map((trace) => trace.label)).toContain(
        'Loading conversation history',
      );
    });
  });

  describe('listSources', () => {
    it('lists the attached data sources', async () => {
      const sources = await provider.listSources();

      expect(sources.length).toBeGreaterThan(0);
      expect(sources[0]?.id).toMatch(/^[A-Z0-9]+$/);
      expect(sources[0]?.name.length).toBeGreaterThan(0);
    });

    it('reports ACL filtering as unknown for managed connectors', async () => {
      const sources = await provider.listSources();

      // The data source APIs do not return the ACL setting for managed connectors,
      // including for this deployment's data source, which has it enabled. Asserted
      // so that a future API change surfaces here as a failing test and the
      // provider can be updated to report it.
      expect(sources.map((source) => source.aclFiltering)).toEqual(
        sources.map(() => 'unknown'),
      );
    });
  });

  /**
   * The access decision that is not a filter.
   *
   * Search and chat *filter a result set*: forget the identity and they return nothing,
   * which is visibly broken and safe. Document fetch *authorizes a named resource*:
   * forget the identity and it returns the document, which looks like it works. So this
   * is the one operation whose ACL behavior has to be demonstrated on a real document,
   * against the real service, rather than reasoned about.
   *
   * The document is located by searching as alejandro rather than hardcoded, so the suite
   * does not depend on a filename in the generated corpus.
   */
  describe('getDocument', () => {
    let financeDocumentId: string;
    let financeDataSourceId: string;

    beforeAll(async () => {
      const page = await provider.search(ALEJANDRO, { text: FINANCE_QUERY });
      const hit = page.hits.find((candidate) =>
        (candidate.uri ?? candidate.id).includes('/finance/'),
      );
      if (hit?.dataSourceId === undefined) {
        throw new Error(
          `no finance document found as alejandro: ${describeHits(page.hits)}. ` +
            'The corpus may not be seeded, or the ACL prefixes may not match.',
        );
      }
      financeDocumentId = hit.id;
      financeDataSourceId = hit.dataSourceId;
    });

    it('serves the document to a user who may read it', async () => {
      const content = await provider.getDocument(
        ALEJANDRO,
        financeDocumentId,
        financeDataSourceId,
      );

      expect(content.url).toMatch(/^https:\/\//);
      expect(content.expiresInSeconds).toBeGreaterThan(0);

      // The URL has to actually work, or this test would pass on a URL that 403s —
      // which is exactly what the private content bucket does to a browser.
      const response = await fetch(content.url);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(FINANCE_FIGURES.some((figure) => body.includes(figure))).toBe(true);
    });

    it('refuses the same document to a user who may not read it', async () => {
      await expect(
        provider.getDocument(AKUA, financeDocumentId, financeDataSourceId),
      ).rejects.toBeInstanceOf(DocumentNotAvailableError);
    });

    it('refuses it to an identity with no access entries anywhere', async () => {
      await expect(
        provider.getDocument(OUTSIDER, financeDocumentId, financeDataSourceId),
      ).rejects.toBeInstanceOf(DocumentNotAvailableError);
    });

    /**
     * A denied document and a nonexistent one must be indistinguishable.
     *
     * `GetDocumentContent` returns distinct errors — `AccessDeniedException` versus
     * `ResourceNotFoundException` — which suits IAM-credentialed callers. This API
     * relays on behalf of end users, so it reports both identically. Asserted against
     * a deployed knowledge base because the distinct errors come from the service.
     */
    it('reports a nonexistent document exactly as it reports a denied one', async () => {
      const missing = financeDocumentId.replace(/[^/]+$/, 'does-not-exist-abc123.md');

      const [denied, absent] = await Promise.all([
        provider
          .getDocument(AKUA, financeDocumentId, financeDataSourceId)
          .catch((error: unknown) => error),
        provider
          .getDocument(AKUA, missing, financeDataSourceId)
          .catch((error: unknown) => error),
      ]);

      expect(denied).toBeInstanceOf(DocumentNotAvailableError);
      expect(absent).toBeInstanceOf(DocumentNotAvailableError);
      expect((absent as Error).message).toBe((denied as Error).message);
    });
  });
});

async function drain(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const collected: ChatEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function describeHits(hits: readonly SearchHit[]): string {
  return hits.length === 0 ? '(none)' : hits.map((hit) => hit.uri ?? hit.id).join(', ');
}
