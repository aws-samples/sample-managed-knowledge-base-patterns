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
  UserIdentity,
} from '../../domain/index.js';
import { RETRIEVAL_PROVIDER } from '../../domain/index.js';
import type { SourcesResponse } from './knowledgebase.controller.js';
import { KnowledgeBaseController } from './knowledgebase.controller.js';

class StubProvider implements RetrievalProvider {
  capabilities: RetrievalCapabilities = { conversationMemory: false };
  sources: readonly KnowledgeSource[] = [];

  search(_identity: UserIdentity, _query: SearchQuery): Promise<SearchPage> {
    return Promise.resolve({ hits: [] });
  }

  async *chat(
    _identity: UserIdentity,
    _request: ChatRequest,
  ): AsyncIterable<ChatEvent> {
    // Not exercised here.
  }

  listSources(): Promise<readonly KnowledgeSource[]> {
    return Promise.resolve(this.sources);
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

describe('KnowledgeBaseController', () => {
  let app: NestExpressApplication;
  let provider: StubProvider;

  beforeEach(async () => {
    provider = new StubProvider();
    const moduleRef = await Test.createTestingModule({
      controllers: [KnowledgeBaseController],
      providers: [{ provide: RETRIEVAL_PROVIDER, useValue: provider }],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists the data sources', async () => {
    provider.sources = [
      {
        id: 'DS1',
        name: 'sample-s3-content',
        aclFiltering: 'unknown',
        type: 'unknown',
      },
    ];

    const response = await request(app.getHttpServer())
      .get('/knowledgebase/sources')
      .expect(200);

    expect(body(response).sources).toEqual([
      {
        id: 'DS1',
        name: 'sample-s3-content',
        aclFiltering: 'unknown',
        type: 'unknown',
      },
    ]);
  });

  /**
   * `unknown` counts as unfiltered.
   *
   * Computed server-side rather than left to each client, because getting it wrong is
   * a security misstatement. For a managed connector the status is typically
   * `unknown`, because the data source APIs do not return the ACL setting, so it is
   * treated as unfiltered for warning purposes and the operator confirms.
   */
  describe('hasUnfilteredSources', () => {
    for (const [aclFiltering, expected] of [
      ['enabled', false],
      ['disabled', true],
      ['unknown', true],
    ] as const) {
      it(`is ${String(expected)} when a source reports ${aclFiltering}`, async () => {
        provider.sources = [{ id: 'DS1', name: 'one', aclFiltering, type: 's3' }];

        const response = await request(app.getHttpServer())
          .get('/knowledgebase/sources')
          .expect(200);

        expect(body(response).hasUnfilteredSources).toBe(expected);
      });
    }

    it('is true when any one source is unfiltered', async () => {
      provider.sources = [
        { id: 'DS1', name: 'filtered', aclFiltering: 'enabled', type: 'sharepoint' },
        { id: 'DS2', name: 'crawled', aclFiltering: 'disabled', type: 'web' },
      ];

      const response = await request(app.getHttpServer())
        .get('/knowledgebase/sources')
        .expect(200);

      // A knowledge base may mix filtered and unfiltered sources, and one unfiltered
      // source is enough to make the corpus unfiltered for practical purposes.
      expect(body(response).hasUnfilteredSources).toBe(true);
    });

    it('is false for an empty knowledge base', async () => {
      const response = await request(app.getHttpServer())
        .get('/knowledgebase/sources')
        .expect(200);

      expect(response.body).toEqual({ sources: [], hasUnfilteredSources: false });
    });
  });

  it('reports provider capabilities so a UI can degrade honestly', async () => {
    provider.capabilities = { conversationMemory: true };

    await request(app.getHttpServer())
      .get('/knowledgebase/capabilities')
      .expect(200)
      .expect({ conversationMemory: true });
  });
});

/** supertest types `body` as `any`; narrow it once rather than at each assertion. */
function body(response: { body: unknown }): SourcesResponse {
  return response.body as SourcesResponse;
}
