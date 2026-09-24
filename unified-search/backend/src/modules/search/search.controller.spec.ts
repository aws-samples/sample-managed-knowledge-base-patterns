import { ValidationPipe } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ChatEvent,
  ChatRequest,
  DocumentContent,
  KnowledgeSource,
  RetrievalCapabilities,
  RetrievalProvider,
  SearchPage,
  SearchQuery,
  UserIdentity as UserIdentityType,
} from '../../domain/index.js';
import {
  AclEvaluationError,
  InvalidQueryError,
  RETRIEVAL_PROVIDER,
  SourceUnavailableError,
  UserIdentity,
} from '../../domain/index.js';
import { IDENTITY_REQUEST_KEY } from '../auth/auth.guard.js';
import { RetrievalExceptionFilter } from '../common/retrieval-exception.filter.js';
import { SearchController } from './search.controller.js';

/**
 * HTTP behavior of the search endpoint.
 *
 * The auth guard is not mounted. Token verification is already tested
 * exhaustively against real signed JWTs, and repeating it here would test the guard
 * rather than the controller. A middleware attaches a verified identity the way the
 * guard would, so these tests cover what is specific to this layer: request
 * validation, the mapping onto domain DTOs, error translation, and the fact that
 * nothing a client sends can influence which identity reaches retrieval.
 *
 * A local recording stub rather than `InMemoryRetrievalProvider`, because what needs
 * asserting is *what the controller passed down*. The domain fake models ACL behavior
 * faithfully and deliberately records nothing; adding spy hooks to it for this test
 * would bend a domain double to a controller's convenience.
 */

const ALEJANDRO = UserIdentity.fromVerifiedClaims({
  email: 'alejandro_rosalez@example.com',
  subject: 'sub-alejandro',
});

class RecordingProvider implements RetrievalProvider {
  readonly capabilities: RetrievalCapabilities = { conversationMemory: false };

  lastIdentity?: UserIdentityType;
  lastQuery?: SearchQuery;
  nextError?: Error;
  page: SearchPage = { hits: [] };

  search(identity: UserIdentityType, query: SearchQuery): Promise<SearchPage> {
    this.lastIdentity = identity;
    this.lastQuery = query;
    if (this.nextError !== undefined) {
      const error = this.nextError;
      this.nextError = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve(this.page);
  }

  async *chat(
    _identity: UserIdentityType,
    _request: ChatRequest,
  ): AsyncIterable<ChatEvent> {
    // Not exercised here; the chat controller has its own spec.
  }

  listSources(): Promise<readonly KnowledgeSource[]> {
    return Promise.resolve([]);
  }

  /**
   * Not exercised by this suite; see documents.controller.spec.ts.
   *
   * Rejecting rather than returning a plausible-looking document, so that a test which
   * reaches this by accident fails instead of asserting against a fiction.
   */
  getDocument(): Promise<DocumentContent> {
    return Promise.reject(new Error('getDocument is not stubbed in this suite'));
  }
}

describe('SearchController', () => {
  let app: NestExpressApplication;
  let provider: RecordingProvider;

  beforeEach(async () => {
    provider = new RecordingProvider();
    provider.page = {
      hits: [
        {
          id: 's3://bucket/finance/q3.md',
          title: 'Q3 Revenue Forecast',
          uri: 'https://bucket.s3.amazonaws.com/finance/q3.md',
          snippet: 'Projected Q3 revenue is $4.2 million.',
          score: 0.42,
          sourceType: 's3',
          metadata: { _data_source_id: 'DS1' },
        },
      ],
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [
        { provide: RETRIEVAL_PROVIDER, useValue: provider },
        { provide: APP_FILTER, useClass: RetrievalExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    // The same pipe configuration as main.ts. `forbidNonWhitelisted` is the mechanism
    // that rejects a smuggled identity field, so a spec that omitted it would be
    // testing a more permissive API than the one that ships.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.use((req: Record<string, unknown>, _res: unknown, next: () => void) => {
      req[IDENTITY_REQUEST_KEY] = ALEJANDRO;
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a domain SearchPage', async () => {
    const response = await request(app.getHttpServer())
      .post('/search')
      .send({ text: 'revenue' })
      .expect(201);

    expect(response.body).toEqual({
      hits: [
        {
          id: 's3://bucket/finance/q3.md',
          title: 'Q3 Revenue Forecast',
          uri: 'https://bucket.s3.amazonaws.com/finance/q3.md',
          snippet: 'Projected Q3 revenue is $4.2 million.',
          score: 0.42,
          sourceType: 's3',
          metadata: { _data_source_id: 'DS1' },
        },
      ],
    });
  });

  it('passes the verified identity as the first argument', async () => {
    await request(app.getHttpServer())
      .post('/search')
      .send({ text: 'revenue' })
      .expect(201);

    expect(provider.lastIdentity).toBe(ALEJANDRO);
  });

  it('maps the optional fields onto the domain query', async () => {
    await request(app.getHttpServer())
      .post('/search')
      .send({
        text: 'revenue',
        maxResults: 5,
        nextToken: 'tok',
        sourceIds: ['DS1', 'DS2'],
      })
      .expect(201);

    expect(provider.lastQuery).toEqual({
      text: 'revenue',
      maxResults: 5,
      nextToken: 'tok',
      sourceIds: ['DS1', 'DS2'],
    });
  });

  it('omits absent fields rather than sending undefined', async () => {
    await request(app.getHttpServer())
      .post('/search')
      .send({ text: 'revenue' })
      .expect(201);

    expect(provider.lastQuery).toEqual({ text: 'revenue' });
  });

  describe('request validation', () => {
    for (const [label, body] of [
      ['a missing query', {}],
      ['an empty query', { text: '' }],
      ['a non-string query', { text: 42 }],
      ['an over-long query', { text: 'x'.repeat(1001) }],
      ['a page size above the cap', { text: 'x', maxResults: 5000 }],
      ['a page size below one', { text: 'x', maxResults: 0 }],
      ['a non-integer page size', { text: 'x', maxResults: 1.5 }],
      [
        'too many source ids',
        { text: 'x', sourceIds: Array.from({ length: 26 }, () => 'DS') },
      ],
    ] as const) {
      it(`rejects ${label}`, async () => {
        await request(app.getHttpServer()).post('/search').send(body).expect(400);
      });
    }
  });

  /**
   * The security property of this layer, tested directly rather than inferred.
   *
   * The DTO declares no identity field and `forbidNonWhitelisted` turns any extra
   * property into a 400. Silently ignoring such a field would also be safe, but
   * rejecting it tells a client immediately that this is not how identity works here.
   */
  describe('a caller cannot supply an identity', () => {
    for (const smuggled of [
      { userId: 'attacker@example.com' },
      { email: 'attacker@example.com' },
      { userContext: { userId: 'attacker@example.com' } },
      { identity: 'attacker@example.com' },
      { subject: 'sub-attacker' },
      { actorId: 'sub-attacker' },
    ]) {
      it(`rejects a body containing ${Object.keys(smuggled).join(', ')}`, async () => {
        await request(app.getHttpServer())
          .post('/search')
          .send({ text: 'revenue', ...smuggled })
          .expect(400);
      });
    }

    it('ignores headers that claim another user', async () => {
      await request(app.getHttpServer())
        .post('/search')
        .set('x-user-email', 'attacker@example.com')
        .set('x-user-id', 'attacker@example.com')
        .set('x-forwarded-user', 'attacker@example.com')
        .send({ text: 'revenue' })
        .expect(201);

      expect(provider.lastIdentity?.email).toBe('alejandro_rosalez@example.com');
    });
  });

  /**
   * Domain errors become HTTP statuses, and no upstream detail reaches the client.
   */
  describe('error mapping', () => {
    for (const [error, status] of [
      [
        new InvalidQueryError(
          'Bedrock rejected the Retrieve request: Text input is required.',
        ),
        400,
      ],
      [new AclEvaluationError('Retrieve could not complete'), 503],
      [new SourceUnavailableError('The knowledge base does not exist.'), 502],
    ] as const) {
      it(`maps ${error.name} to ${String(status)}`, async () => {
        provider.nextError = error;

        const response = await request(app.getHttpServer())
          .post('/search')
          .send({ text: 'revenue' })
          .expect(status);

        // SDK error wording and service names stay server-side.
        const body = JSON.stringify(response.body);
        expect(body).not.toContain('Bedrock');
        expect(body).not.toContain('Text input');
      });
    }

    it('tells the caller results would be incomplete when ACL evaluation fails', async () => {
      provider.nextError = new AclEvaluationError('simulated');

      const response = await request(app.getHttpServer())
        .post('/search')
        .send({ text: 'revenue' })
        .expect(503);

      // Distinct from an empty page: a short list presented as complete is the
      // failure this error type exists to prevent.
      expect((response.body as { message: string }).message).toMatch(/incomplete/i);
    });
  });
});
