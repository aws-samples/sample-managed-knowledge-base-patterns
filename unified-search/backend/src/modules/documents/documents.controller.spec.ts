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
  DocumentNotAvailableError,
  RETRIEVAL_PROVIDER,
  UserIdentity,
} from '../../domain/index.js';
import { IDENTITY_REQUEST_KEY } from '../auth/auth.guard.js';
import { RetrievalExceptionFilter } from '../common/retrieval-exception.filter.js';
import { DocumentsController } from './documents.controller.js';

/**
 * HTTP behavior of the document content endpoint.
 *
 * The guard is not mounted, for the reason given in the search controller's spec:
 * token verification is tested against real signed JWTs elsewhere, and repeating it here
 * would test the guard. A middleware attaches a verified identity the way the guard
 * would.
 *
 * What is specific to this endpoint, and what these tests are for: it is the one route
 * that makes an access decision about a *named resource*, so the identity it uses must
 * be the verified one and nothing else, and a denial must be indistinguishable from a
 * document that does not exist.
 */
const ALEJANDRO = UserIdentity.fromVerifiedClaims({
  email: 'alejandro_rosalez@example.com',
  subject: 'sub-alejandro',
});

const CONTENT: DocumentContent = {
  mimeType: 'text/plain',
  url: 'https://content.example.com/signed?X-Amz-Expires=300',
  expiresInSeconds: 300,
  sizeBytes: 706,
};

class RecordingProvider implements RetrievalProvider {
  capabilities: RetrievalCapabilities = { conversationMemory: false };
  lastIdentity: UserIdentityType | undefined;
  lastDocumentId: string | undefined;
  lastDataSourceId: string | undefined;
  nextError: Error | undefined;

  search(_identity: UserIdentityType, _query: SearchQuery): Promise<SearchPage> {
    return Promise.resolve({ hits: [] });
  }

  async *chat(
    _identity: UserIdentityType,
    _request: ChatRequest,
  ): AsyncIterable<ChatEvent> {
    // Not exercised here.
  }

  listSources(): Promise<readonly KnowledgeSource[]> {
    return Promise.resolve([]);
  }

  getDocument(
    identity: UserIdentityType,
    documentId: string,
    dataSourceId: string,
  ): Promise<DocumentContent> {
    this.lastIdentity = identity;
    this.lastDocumentId = documentId;
    this.lastDataSourceId = dataSourceId;
    if (this.nextError !== undefined) {
      const error = this.nextError;
      this.nextError = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve(CONTENT);
  }
}

describe('DocumentsController', () => {
  let app: NestExpressApplication;
  let provider: RecordingProvider;

  beforeEach(async () => {
    provider = new RecordingProvider();
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [
        { provide: RETRIEVAL_PROVIDER, useValue: provider },
        { provide: APP_FILTER, useClass: RetrievalExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    // The same pipe configuration as main.ts. `forbidNonWhitelisted` is what rejects a
    // smuggled identity field, so a spec without it would test a more permissive API
    // than the one that ships.
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

  const body = {
    documentId: 's3://bucket/content/finance/q3.md',
    dataSourceId: 'DS1',
  };

  it('returns the document content descriptor', async () => {
    const response = await request(app.getHttpServer())
      .post('/documents/content')
      .send(body)
      .expect(201);

    expect(response.body).toEqual(CONTENT);
  });

  it('passes the verified identity as the first argument', async () => {
    await request(app.getHttpServer())
      .post('/documents/content')
      .send(body)
      .expect(201);

    expect(provider.lastIdentity).toBe(ALEJANDRO);
    expect(provider.lastDocumentId).toBe(body.documentId);
    expect(provider.lastDataSourceId).toBe('DS1');
  });

  /**
   * The reason this endpoint is the sharpest one in the sample.
   *
   * A search that loses the identity returns an empty page and looks broken. A
   * document fetch that loses it returns the document and looks like it works, so the
   * only thing standing between the two is that the identity cannot be influenced from
   * the request at all.
   */
  it.each(['userId', 'email', 'userContext', 'identity', 'sub'])(
    'rejects a request carrying %s rather than ignoring it',
    async (field) => {
      await request(app.getHttpServer())
        .post('/documents/content')
        .send({ ...body, [field]: 'akua_mansa@example.com' })
        .expect(400);

      expect(provider.lastIdentity).toBeUndefined();
    },
  );

  it('still uses the verified identity when the body names another user', async () => {
    // Belt and braces: even if the whitelist were relaxed, nothing reads the body.
    await request(app.getHttpServer())
      .post('/documents/content')
      .send(body)
      .set('X-User-Id', 'akua_mansa@example.com')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(201);

    expect(provider.lastIdentity).toBe(ALEJANDRO);
  });

  describe('when the document is not available', () => {
    /**
     * 404 and not 403, for both causes, with one message.
     *
     * A 403 would confirm the document exists. `GetDocumentContent` returns distinct
     * errors for the two cases, which suits IAM-credentialed callers; this API relays
     * on behalf of end users, so the provider collapses them before they reach here.
     */
    it('answers 404 without saying which cause it was', async () => {
      provider.nextError = new DocumentNotAvailableError(
        'That document is not available. It may not exist, or you may not have ' +
          'permission to read it.',
      );

      const response = await request(app.getHttpServer())
        .post('/documents/content')
        .send(body)
        .expect(404);

      const payload = response.body as { message?: string };
      expect(payload.message).toMatch(/not available/i);
      // Nothing in the response may hint at which of the two cases occurred.
      expect(JSON.stringify(response.body)).not.toMatch(/denied|forbidden|exists/i);
    });
  });

  describe('request validation', () => {
    it('requires a document id', async () => {
      await request(app.getHttpServer())
        .post('/documents/content')
        .send({ dataSourceId: 'DS1' })
        .expect(400);
    });

    it('requires a data source id', async () => {
      await request(app.getHttpServer())
        .post('/documents/content')
        .send({ documentId: body.documentId })
        .expect(400);
    });

    it('rejects an over-long document id', async () => {
      await request(app.getHttpServer())
        .post('/documents/content')
        .send({ ...body, documentId: `s3://bucket/${'x'.repeat(3000)}` })
        .expect(400);
    });
  });
});
