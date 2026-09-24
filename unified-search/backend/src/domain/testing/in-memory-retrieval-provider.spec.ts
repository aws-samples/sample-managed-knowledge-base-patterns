import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '../chat.js';
import { collectChat } from '../chat.js';
import {
  AclEvaluationError,
  DocumentNotAvailableError,
  InvalidQueryError,
} from '../errors.js';
import { UserIdentity } from '../identity.js';
import type { SearchHit } from '../search.js';
import {
  type FakeDocument,
  InMemoryRetrievalProvider,
} from './in-memory-retrieval-provider.js';

const alejandro = UserIdentity.fromVerifiedClaims({
  email: 'alejandro_rosalez@example.com',
  subject: 'sub-alejandro',
});
const akua = UserIdentity.fromVerifiedClaims({
  email: 'akua_mansa@example.com',
  subject: 'sub-akua',
});

function hit(id: string, snippet: string): SearchHit {
  return {
    id,
    title: `Document ${id}`,
    uri: `s3://corpus/${id}`,
    snippet,
    score: 0.5,
    sourceType: 's3',
    metadata: {},
  };
}

function doc(
  overrides: Partial<FakeDocument> & Pick<FakeDocument, 'hit'>,
): FakeDocument {
  return {
    sourceId: 'source-a',
    allowedEmails: [alejandro.email],
    ...overrides,
  };
}

describe('InMemoryRetrievalProvider', () => {
  describe('access control fidelity', () => {
    let provider: InMemoryRetrievalProvider;

    beforeEach(() => {
      provider = new InMemoryRetrievalProvider({
        documents: [
          doc({ hit: hit('alejandro-only', 'quarterly revenue figures') }),
          doc({
            hit: hit('shared', 'quarterly headcount figures'),
            allowedEmails: [alejandro.email, akua.email],
          }),
          doc({
            hit: hit('denied-to-akua', 'quarterly board minutes'),
            allowedEmails: [alejandro.email, akua.email],
            deniedEmails: [akua.email],
          }),
          // No access control entry at all.
          doc({
            hit: hit('orphaned-acl', 'quarterly legal review'),
            allowedEmails: [],
          }),
        ],
      });
    });

    it('returns only documents the user may read', async () => {
      const page = await provider.search(akua, { text: 'quarterly' });

      expect(page.hits.map((h) => h.id)).toEqual(['shared']);
    });

    it('gives a differently-permissioned user a different result set', async () => {
      const page = await provider.search(alejandro, { text: 'quarterly' });

      expect(page.hits.map((h) => h.id)).toEqual([
        'alejandro-only',
        'shared',
        'denied-to-akua',
      ]);
    });

    // Deny overriding allow is Bedrock's documented evaluation order.
    it('denies when a user appears in both allow and deny lists', async () => {
      const page = await provider.search(akua, { text: 'board minutes' });

      expect(page.hits).toEqual([]);
    });

    // Bedrock treats a document with no ACL as restricted, not public. On an
    // ACL-enabled S3 source such a document is not even ingested.
    it('returns a document with no access control entry to nobody', async () => {
      const forAlejandro = await provider.search(alejandro, { text: 'legal review' });
      const forAkua = await provider.search(akua, { text: 'legal review' });

      expect(forAlejandro.hits).toEqual([]);
      expect(forAkua.hits).toEqual([]);
    });
  });

  describe('pagination', () => {
    const documents = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      doc({ hit: hit(id, `report ${id}`) }),
    );

    it('pages through results with a continuation token', async () => {
      const provider = new InMemoryRetrievalProvider({ documents });

      const first = await provider.search(alejandro, { text: 'report', maxResults: 2 });
      expect(first.hits.map((h) => h.id)).toEqual(['a', 'b']);
      expect(first.nextToken).toBeDefined();

      const second = await provider.search(alejandro, {
        text: 'report',
        maxResults: 2,
        nextToken: first.nextToken,
      });
      expect(second.hits.map((h) => h.id)).toEqual(['c', 'd']);

      const third = await provider.search(alejandro, {
        text: 'report',
        maxResults: 2,
        nextToken: second.nextToken,
      });
      expect(third.hits.map((h) => h.id)).toEqual(['e']);
      expect(third.nextToken).toBeUndefined();
    });

    // Real-time ACL verification can drop candidates without backfilling, so a
    // short page is not a signal that results are exhausted. Callers that infer
    // "last page" from a short page will silently truncate.
    it('can return fewer hits than requested while more remain', async () => {
      const provider = new InMemoryRetrievalProvider({
        documents: [
          doc({ hit: hit('visible-1', 'report one') }),
          doc({ hit: hit('hidden', 'report two'), allowedEmails: [akua.email] }),
          doc({ hit: hit('visible-2', 'report three') }),
        ],
      });

      const page = await provider.search(alejandro, { text: 'report', maxResults: 2 });

      expect(page.hits.map((h) => h.id)).toEqual(['visible-1', 'visible-2']);
      expect(page.hits.length).toBeLessThan(2 + 1);
    });

    it('rejects an unusable continuation token', async () => {
      const provider = new InMemoryRetrievalProvider({ documents });

      await expect(
        provider.search(alejandro, { text: 'report', nextToken: 'not-a-number' }),
      ).rejects.toThrow(InvalidQueryError);
    });
  });

  describe('source scoping', () => {
    it('restricts results to the requested data sources', async () => {
      const provider = new InMemoryRetrievalProvider({
        documents: [
          doc({ hit: hit('in-a', 'policy document'), sourceId: 'source-a' }),
          doc({ hit: hit('in-b', 'policy document'), sourceId: 'source-b' }),
        ],
      });

      const page = await provider.search(alejandro, {
        text: 'policy',
        sourceIds: ['source-b'],
      });

      expect(page.hits.map((h) => h.id)).toEqual(['in-b']);
    });

    it('treats an empty source list as unscoped', async () => {
      const provider = new InMemoryRetrievalProvider({
        documents: [
          doc({ hit: hit('in-a', 'policy document'), sourceId: 'source-a' }),
          doc({ hit: hit('in-b', 'policy document'), sourceId: 'source-b' }),
        ],
      });

      const page = await provider.search(alejandro, { text: 'policy', sourceIds: [] });

      expect(page.hits).toHaveLength(2);
    });
  });

  describe('fail-closed behavior', () => {
    // Distinguishing this from an empty result set is the reason
    // AclEvaluationError exists: callers must be able to tell the user their
    // results are incomplete rather than presenting a short list as complete.
    it('raises AclEvaluationError rather than returning an empty page', async () => {
      const provider = new InMemoryRetrievalProvider({
        documents: [doc({ hit: hit('a', 'anything') })],
        failAclEvaluation: true,
      });

      await expect(provider.search(alejandro, { text: 'anything' })).rejects.toThrow(
        AclEvaluationError,
      );
    });

    /**
     * Chat surfaces the failure on *iteration*, not on the call.
     *
     * Calling an async generator returns an iterable without running any of its
     * body, so `expect(provider.chat(...)).rejects` would silently never assert
     * anything. This is the documented contract of the port — a `for await` inside
     * a `try`/`catch` catches it — and it is worth pinning, because a caller that
     * wraps only the call site and not the loop will miss every mid-stream error.
     */
    it('propagates the failure through chat, on iteration', async () => {
      const provider = new InMemoryRetrievalProvider({
        documents: [doc({ hit: hit('a', 'anything') })],
        failAclEvaluation: true,
      });

      await expect(
        collectChat(provider.chat(alejandro, { message: 'anything' })),
      ).rejects.toThrow(AclEvaluationError);
    });

    it('does not throw merely from calling chat', async () => {
      const provider = new InMemoryRetrievalProvider({
        documents: [doc({ hit: hit('a', 'anything') })],
        failAclEvaluation: true,
      });

      // Documents the asymmetry with search(), which rejects immediately.
      const iterable = provider.chat(alejandro, { message: 'anything' });
      expect(iterable).toBeDefined();

      await expect(collectChat(iterable)).rejects.toThrow(AclEvaluationError);
    });
  });

  describe('chat', () => {
    const provider = new InMemoryRetrievalProvider({
      documents: [
        doc({ hit: hit('one', 'Revenue grew.') }),
        doc({ hit: hit('two', 'Costs fell.') }),
      ],
    });

    it('cites every grounding passage', async () => {
      const turn = await collectChat(provider.chat(alejandro, { message: 'Revenue' }));

      expect(turn.citations).toHaveLength(1);
      expect(turn.citations[0]?.references[0]?.documentId).toBe('one');
    });

    it('produces citation spans that index into the assembled answer', async () => {
      const turn = await collectChat(provider.chat(alejandro, { message: '' }));

      // The span contract is that answer.slice(start, end) is the cited text.
      // An offset error here would misplace every inline citation in the UI, so
      // the arithmetic is checked directly. It matters more because the answer
      // arrives in several chunks: spans index into the concatenation, not into
      // any single event.
      expect(turn.citations.length).toBeGreaterThan(1);
      for (const citation of turn.citations) {
        expect(turn.answer.slice(citation.span.start, citation.span.end)).toBe(
          citation.text,
        );
      }
    });

    it('streams the answer as more than one event', async () => {
      // Guards the assertion above from becoming vacuous. If the fake emitted the
      // whole answer in a single event, a caller that mishandles concatenation
      // would pass here and fail against the real provider.
      const events: ChatEvent[] = [];
      for await (const event of provider.chat(alejandro, { message: '' })) {
        events.push(event);
      }

      expect(events.filter((e) => e.kind === 'answer').length).toBeGreaterThan(1);
    });

    it('emits sources and a trace before the citations', async () => {
      const kinds: ChatEvent['kind'][] = [];
      for await (const event of provider.chat(alejandro, { message: 'Revenue' })) {
        kinds.push(event.kind);
      }

      expect(kinds).toContain('trace');
      expect(kinds).toContain('sources');
      // Citations describe the finished answer, so they arrive last.
      expect(kinds.at(-1)).toBe('citations');
    });

    it('answers without citations when nothing is visible', async () => {
      const turn = await collectChat(provider.chat(akua, { message: 'Revenue' }));

      expect(turn.citations).toEqual([]);
      expect(turn.answer).toMatch(/no relevant information/i);
    });
  });

  describe('capabilities', () => {
    // Memory is optional infrastructure. Reporting the capability lets a chat UI
    // say history is unavailable rather than appearing to forget.
    it('reports no conversation memory by default', () => {
      expect(new InMemoryRetrievalProvider().capabilities.conversationMemory).toBe(
        false,
      );
    });

    it('reports conversation memory when configured', () => {
      const provider = new InMemoryRetrievalProvider({ conversationMemory: true });

      expect(provider.capabilities.conversationMemory).toBe(true);
    });
  });

  describe('listSources', () => {
    it('reports which sources enforce access control', async () => {
      const provider = new InMemoryRetrievalProvider({
        sources: [
          {
            id: 'source-a',
            name: 'Finance SharePoint',
            aclFiltering: 'enabled',
            type: 'sharepoint',
          },
          {
            id: 'source-b',
            name: 'Public docs',
            aclFiltering: 'disabled',
            type: 'web',
          },
          // The typical case for a managed connector: the data source APIs do not
          // return the ACL setting, so the provider reports `unknown`.
          {
            id: 'source-c',
            name: 'Managed connector',
            aclFiltering: 'unknown',
            type: 'unknown',
          },
        ],
      });

      const sources = await provider.listSources();

      // A non-ACL source returns its documents to every user regardless of
      // identity, so this flag is the difference between a filtered and an
      // unfiltered corpus. `unknown` has to be treated as the unfiltered case.
      expect(sources.map((s) => [s.id, s.aclFiltering])).toEqual([
        ['source-a', 'enabled'],
        ['source-b', 'disabled'],
        ['source-c', 'unknown'],
      ]);
    });
  });

  /**
   * The fake has to reproduce one specific property of the real provider: a document
   * you may not read and a document that does not exist are the **same** failure.
   *
   * If the fake distinguished them, a caller could be written to branch on that
   * difference, pass its tests, and then behave wrongly against a provider that
   * collapses the two on purpose — the collapse being what stops the API disclosing
   * which documents exist.
   */
  describe('getDocument', () => {
    let provider: InMemoryRetrievalProvider;

    beforeEach(() => {
      provider = new InMemoryRetrievalProvider({
        documents: [
          doc({ hit: hit('finance-1', 'Projected revenue is 4.2 million.') }),
          doc({
            hit: hit('shared-1', 'Expenses are reimbursed within 30 days.'),
            allowedEmails: [alejandro.email, akua.email],
          }),
          doc({
            hit: hit('revoked-1', 'Nobody may read this.'),
            allowedEmails: [alejandro.email],
            deniedEmails: [alejandro.email],
          }),
        ],
      });
    });

    it('serves a document the user may read', async () => {
      const content = await provider.getDocument(alejandro, 'finance-1', 'source-a');

      expect(content.mimeType).toBe('text/plain');
      expect(content.expiresInSeconds).toBeGreaterThan(0);
      // A `data:` URL so a test that actually fetches it gets the fake's own content
      // rather than reaching the network or succeeding against nothing.
      expect(content.url.startsWith('data:text/plain;base64,')).toBe(true);
      expect(Buffer.from(content.url.split(',')[1] ?? '', 'base64').toString()).toBe(
        'Projected revenue is 4.2 million.',
      );
    });

    it.each([
      ['a document the user may not read', 'finance-1'],
      ['a document that does not exist', 'no-such-document'],
      ['a document where deny overrides allow', 'revoked-1'],
    ])('refuses %s', async (_label, documentId) => {
      const identity = documentId === 'revoked-1' ? alejandro : akua;

      await expect(
        provider.getDocument(identity, documentId, 'source-a'),
      ).rejects.toBeInstanceOf(DocumentNotAvailableError);
    });

    it('reports all three refusals with an identical message', async () => {
      const messages = await Promise.all(
        [
          provider.getDocument(akua, 'finance-1', 'source-a'),
          provider.getDocument(akua, 'no-such-document', 'source-a'),
          provider.getDocument(alejandro, 'revoked-1', 'source-a'),
        ].map(async (pending) =>
          pending.then(
            () => 'resolved',
            (error: unknown) => (error as Error).message,
          ),
        ),
      );

      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).not.toBe('resolved');
    });

    it('refuses a document from a different data source', async () => {
      // Both identifiers are required by the real operation, so a mismatched pair
      // must not resolve just because the document id happens to exist.
      await expect(
        provider.getDocument(alejandro, 'finance-1', 'source-b'),
      ).rejects.toBeInstanceOf(DocumentNotAvailableError);
    });

    it('rejects rather than throwing synchronously when ACL evaluation fails', async () => {
      const failing = new InMemoryRetrievalProvider({ failAclEvaluation: true });

      await expect(
        failing.getDocument(alejandro, 'finance-1', 'source-a'),
      ).rejects.toBeInstanceOf(AclEvaluationError);
    });
  });
});
