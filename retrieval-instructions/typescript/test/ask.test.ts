import type { AgenticRetrieveStreamCommandInput } from '@aws-sdk/client-bedrock-agent-runtime';
import { describe, expect, it } from 'vitest';
import { askAsTenant, buildRequest, readStream, sendRequest } from '../src/ask';
import { classify, keyFromExpansionMessage, keyFromSourceUri } from '../src/corpus';
import { filterFor } from '../src/filters';
import { documentRows, formatIsolation } from '../src/formats';
import * as stateFile from '../src/state';
import {
  type TenantFilter,
  southRetrieverFilters,
  tenantRequest,
  tenantScope,
} from '../src/tenancy';
import { FakeRuntime, fixture, streamResponse } from './support';

const KB = 'ABCDE12345';
const SOUTH_KB = 'FGHIJ67890';
const STATE = stateFile.parse(fixture('state.json'));
const Q = 'How many days do I have to return an opened AnySmartProduct-5?';

function filterOf(request: AgenticRetrieveStreamCommandInput, i = 0): unknown {
  return request.retrievers?.[i]?.configuration?.knowledgeBase?.retrievalOverrides
    ?.filter;
}

describe('request shapes', () => {
  it('carries the filter each call graph row lists', () => {
    const req = tenantRequest(STATE, 'sales-region-north', null, '1');
    const team = tenantRequest(STATE, 'team-support', null, '2');
    const [baseLine, baseFilter] = tenantScope('sales-region-central', null);
    const [fShared, fSouth] = southRetrieverFilters();
    const rows: Record<string, [AgenticRetrieveStreamCommandInput, unknown[]]> = {
      'ask without a tenant line': [
        buildRequest({
          question: Q,
          retrievers: [[KB, team.tenantFilter]],
          tenantLine: null,
          instructionId: team.instructionId,
          version: team.version,
        }),
        [filterFor(null, 'team-support')],
      ],
      baseline: [
        buildRequest({
          question: Q,
          retrievers: [[KB, null]],
          tenantLine: null,
          instructionId: null,
          version: null,
        }),
        [undefined],
      ],
      'baseline --tenant': [
        buildRequest({
          question: Q,
          retrievers: [[KB, baseFilter]],
          tenantLine: baseLine,
          instructionId: null,
          version: null,
        }),
        [filterFor('sales-region-central')],
      ],
      'isolation unfiltered': [
        buildRequest({
          question: Q,
          retrievers: [[KB, null]],
          tenantLine: req.tenantLine,
          instructionId: req.instructionId,
          version: req.version,
          generateResponse: false,
        }),
        [undefined],
      ],
      'isolation filtered': [
        buildRequest({
          question: Q,
          retrievers: [[KB, req.tenantFilter]],
          tenantLine: req.tenantLine,
          instructionId: req.instructionId,
          version: req.version,
          generateResponse: false,
        }),
        [filterFor('sales-region-north')],
      ],
      'multi-kb': [
        buildRequest({
          question: Q,
          retrievers: [
            [KB, fShared],
            [SOUTH_KB, fSouth],
          ],
          tenantLine: 'Customer sales region: Sales Region South.',
          instructionId: 'uvwxy12345',
          version: '1',
        }),
        [fShared, fSouth],
      ],
    };
    for (const [name, [request, filters]] of Object.entries(rows)) {
      expect(
        filters.map((_, i) => filterOf(request, i)),
        name,
      ).toEqual(filters);
    }
    expect(rows['isolation filtered']?.[0].generateResponse).toBe(false);
    expect(rows.baseline?.[0]).not.toHaveProperty('generateResponse');
    expect(rows.baseline?.[0]).not.toHaveProperty('retrievalInstructionConfiguration');
  });

  it('sends the same request from both senders for the same tenant request', async () => {
    const req = tenantRequest(STATE, 'team-support', 'sales-region-north', '2');
    const snippet = new FakeRuntime('ask-team.json');
    const general = new FakeRuntime('ask-team.json');
    await askAsTenant(snippet.client(), req, KB, Q);
    await sendRequest(
      general.client(),
      buildRequest({
        question: Q,
        retrievers: [[KB, req.tenantFilter]],
        tenantLine: req.tenantLine,
        instructionId: req.instructionId,
        version: req.version,
      }),
    );
    expect(snippet.calls).toEqual(general.calls);
    const sent = snippet.calls[0] as unknown as AgenticRetrieveStreamCommandInput;
    expect(sent.messages?.[0]?.content?.text).toBe(
      `Customer sales region: Sales Region North.\n${Q}`,
    );
    expect(sent.retrievalInstructionConfiguration).toEqual({
      retrievalInstructionId: 'fghij67890',
      version: '2',
    });
  });

  it('refuses askAsTenant without a tenant line or with DRAFT', async () => {
    const runtime = new FakeRuntime().client();
    await expect(
      askAsTenant(runtime, tenantRequest(STATE, 'team-support', null, '1'), KB, Q),
    ).rejects.toThrow(RangeError);
    await expect(
      askAsTenant(
        runtime,
        tenantRequest(STATE, 'sales-region-north', null, 'DRAFT'),
        KB,
        Q,
      ),
    ).rejects.toThrow(RangeError);
  });

  it('omits the version for DRAFT', () => {
    const req = tenantRequest(STATE, 'sales-region-north', null, 'DRAFT');
    const request = buildRequest({
      question: Q,
      retrievers: [[KB, req.tenantFilter]],
      tenantLine: req.tenantLine,
      instructionId: req.instructionId,
      version: req.version,
    });
    expect(request.retrievalInstructionConfiguration).toEqual({
      retrievalInstructionId: 'abcde12345',
    });
  });

  it('differs only by the overrides in multi-kb without filters', () => {
    const [fShared, fSouth] = southRetrieverFilters();
    const common = {
      question: Q,
      tenantLine: 'Customer sales region: Sales Region South.',
      instructionId: 'uvwxy12345',
      version: '1',
    };
    const filtered = buildRequest({
      ...common,
      retrievers: [
        [KB, fShared],
        [SOUTH_KB, fSouth],
      ],
    });
    const unfiltered = buildRequest({
      ...common,
      retrievers: [
        [KB, null],
        [SOUTH_KB, null],
      ],
    });
    for (const r of filtered.retrievers ?? [])
      delete r.configuration?.knowledgeBase?.retrievalOverrides;
    expect(filtered).toEqual(unfiltered);
    expect(
      unfiltered.retrievers?.map(
        (r) => r.configuration?.knowledgeBase?.knowledgeBaseId,
      ),
    ).toEqual([KB, SOUTH_KB]);
  });

  it('refuses more than five retrievers', () => {
    const retrievers: [string, TenantFilter | null][] = Array.from(
      { length: 6 },
      (_, i) => [`KB${String(i).padStart(8, '0')}`, null],
    );
    expect(() =>
      buildRequest({
        question: Q,
        retrievers,
        tenantLine: null,
        instructionId: null,
        version: null,
      }),
    ).toThrow(RangeError);
  });
});

describe('readStream', () => {
  it('fills every field', async () => {
    const result = await readStream(streamResponse('ask-region.json'));
    expect(result.applied).toEqual({ id: 'klmno12345', version: '1' });
    expect(result.answer?.endsWith('Source: central-returns-addendum.md')).toBe(true);
    expect(result.responseText.startsWith('Si compró')).toBe(true);
    expect(result.planning?.message).toBe('Agent planning started (devolución)');
    expect(result.documents[0]).toEqual({
      step: 'SpeculativeRetrieval',
      key: 'docs/sales-region-central/central-returns-addendum.md',
      retriever: KB,
    });
    expect(result.documents.at(-1)?.step).toBe('result');
    expect(result.error).toBeNull();
  });

  it('stores an empty answer as null', async () => {
    const result = await readStream(streamResponse('empty-answer.json'));
    expect(result.answer).toBeNull();
    expect(result.responseText).toBe('  ');
  });

  it('names the key from the FullDocumentExpansion IN_PROGRESS message', async () => {
    const result = await readStream(streamResponse('full-document-expansion.json'));
    expect(result.documents).toEqual([
      {
        step: 'FullDocumentExpansion',
        key: 'docs/sales-region-north/north-returns-addendum.md',
        retriever: KB,
      },
      { step: 'FullDocumentExpansion', key: null, retriever: KB },
    ]);
  });

  it('stores a modeled in-stream exception with its name', async () => {
    const result = await readStream(streamResponse('midstream-error.json'));
    expect(result.error).toEqual({
      code: 'AccessDeniedException',
      message: 'The caller is not authorized to use this retrieval instruction.',
    });
    expect(result.applied).toEqual({ id: 'fghij67890', version: '1' });
    expect(result.documents).toHaveLength(1);
  });

  it('lets any other error propagate', async () => {
    async function* broken(): AsyncGenerator<never> {
      yield* [];
      throw new Error('socket hang up');
    }
    await expect(readStream({ stream: broken() })).rejects.toThrow('socket hang up');
  });
});

describe('document keys and classification', () => {
  it('reads keys from _source_uri and the expansion message', () => {
    expect(
      keyFromSourceUri(
        'https://amzn-s3-demo-bucket.s3.amazonaws.com/docs/global/a%20b.md',
      ),
    ).toBe('docs/global/a b.md');
    expect(
      keyFromSourceUri(
        'https://s3.us-east-1.amazonaws.com/amzn-s3-demo-bucket/docs/global/x.md',
      ),
    ).toBe('docs/global/x.md');
    expect(
      keyFromSourceUri('https://amzn-s3-demo-bucket.s3.amazonaws.com/other/x.md'),
    ).toBeNull();
    expect(keyFromSourceUri(null)).toBeNull();
    expect(
      keyFromExpansionMessage(
        'Starting full document expansion for document: s3://b/docs/x.md',
      ),
    ).toBe('docs/x.md');
    expect(keyFromExpansionMessage('Starting full document expansion')).toBeNull();
  });

  it('fails the isolation check for unknown documents', async () => {
    expect(
      classify('docs/global/not-in-the-manifest.md', 'sales-region-north').entitled,
    ).toBe('unknown');
    expect(classify(null, 'sales-region-north').document).toBe('unknown');
    const unfiltered = await readStream(streamResponse('isolation-unfiltered.json'));
    const filtered = {
      ...(await readStream(streamResponse('isolation-filtered.json'))),
      documents: [
        { step: 'Retrieval', key: 'docs/global/not-in-the-manifest.md', retriever: KB },
      ],
    };
    const [, ok] = formatIsolation({
      tenant: 'sales-region-north',
      region: null,
      question: Q,
      unfiltered,
      filtered,
    });
    expect(ok).toBe(false);
    expect(documentRows(filtered, 'sales-region-north', null)).toEqual([
      [['Retrieval', 'unknown', 'unknown', 'unknown']],
      1,
      1,
    ]);
  });

  it('passes the isolation check on the filtered fixture', async () => {
    const [, ok] = formatIsolation({
      tenant: 'sales-region-north',
      region: null,
      question: Q,
      unfiltered: await readStream(streamResponse('isolation-unfiltered.json')),
      filtered: await readStream(streamResponse('isolation-filtered.json')),
    });
    expect(ok).toBe(true);
  });
});
