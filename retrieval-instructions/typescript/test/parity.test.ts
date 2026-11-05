/** Every formatter against test-fixtures/expected/*.txt. The Python tests read the same files. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type StreamResult, readStream } from '../src/ask';
import { Lookup, lookup } from '../src/cloudtrail';
import {
  formatAnswer,
  formatCloudtrail,
  formatCreate,
  formatIsolation,
  formatMultiKb,
  formatReleaseRoute,
  formatReleaseShow,
  formatStatus,
  formatStructuredJson,
  formatSupportV2,
  formatTeardownLine,
  formatTeardownPlan,
  formatTeardownSummary,
  formatVerifyAbac,
} from '../src/formats';
import { candidate } from '../src/instructions';
import { tenantLine } from '../src/labels';
import * as stateFile from '../src/state';
import {
  FIXTURES,
  FakeCloudTrail,
  NOW,
  fixture,
  noSleep,
  streamResponse,
} from './support';

const CASES = fs
  .readdirSync(path.join(FIXTURES, 'expected'))
  .filter((f) => f.endsWith('.txt'))
  .map((f) => f.slice(0, -'.txt'.length))
  .sort();

const stream = (name: string): Promise<StreamResult> =>
  readStream(streamResponse(name));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the input files are untyped JSON
async function render(inp: any): Promise<string> {
  const command: string = inp.command;
  if (command === 'ask' || command === 'baseline') {
    return formatAnswer({
      tenant: inp.tenant,
      instruction: inp.instruction ?? null,
      version: inp.version ?? null,
      requestIndex: inp.requestIndex ?? null,
      trace: inp.trace ?? false,
      tenantLine: inp.tenantLine,
      tenantFilter: inp.filter,
      question: inp.question,
      result: await stream(inp.stream),
    });
  }
  if (command === 'isolation') {
    const [text] = formatIsolation({
      tenant: inp.tenant,
      region: null,
      question: inp.question,
      unfiltered: await stream(inp.unfiltered),
      filtered: await stream(inp.filtered),
    });
    return text;
  }
  if (command === 'multi-kb') {
    const [text] = formatMultiKb({
      instruction: inp.instruction,
      version: inp.version,
      sharedId: inp.sharedKnowledgeBaseId,
      southId: inp.southKnowledgeBaseId,
      sharedFilter: inp.sharedFilter,
      southFilter: inp.southFilter,
      tenantLine: tenantLine('sales-region-south'),
      question: inp.question,
      result: await stream(inp.stream),
    });
    return text;
  }
  if (command === 'structured-json') {
    const [text] = formatStructuredJson({
      instruction: inp.instruction,
      version: inp.version,
      tenantFilter: inp.filter,
      question: inp.question,
      result: await stream(inp.stream),
    });
    return text;
  }
  if (command === 'status') return formatStatus(inp);
  if (command === 'create-instructions') return formatCreate(inp);
  if (command === 'support-v2') return formatSupportV2(inp);
  if (
    command === 'release-show' ||
    command === 'release-route' ||
    command === 'cloudtrail'
  ) {
    const recorded = stateFile.load(path.join(FIXTURES, inp.state));
    if (recorded === null) throw new Error('missing state fixture');
    if (command === 'release-show') return formatReleaseShow(recorded);
    if (command === 'release-route') {
      const cfg = recorded.release[inp.tenant];
      if (cfg === undefined) throw new Error('missing release entry');
      return formatReleaseRoute(inp.tenant, cfg, inp.requests);
    }
    const idToKey = new Map(
      Object.entries(recorded.instructions).map(([key, e]) => [e.id, key]),
    );
    const client = new Lookup(new FakeCloudTrail(inp.pages).client(), noSleep);
    const [rows, streams] = await lookup(client, idToKey, inp.since, NOW);
    return formatCloudtrail(inp.since, rows, streams);
  }
  if (command === 'verify-abac')
    return formatVerifyAbac(inp.tenant, inp.other, inp.checks);
  if (command === 'teardown-plan') {
    return formatTeardownPlan(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON
      inp.candidates.map((c: any) =>
        candidate(null, c.name, c.id, 'arn', {
          versions: c.versions,
          action: c.action,
          reason: c.reason,
        }),
      ),
    );
  }
  if (command === 'teardown') {
    const lines = inp.outcomes.map(formatTeardownLine).join('');
    return lines + formatTeardownSummary(inp.outcomes, inp.stateFileRemoved);
  }
  throw new Error(`no formatter for ${command}`);
}

describe('parity with test-fixtures/expected', () => {
  it.each(CASES)('%s', async (name) => {
    const expected = fs.readFileSync(
      path.join(FIXTURES, 'expected', `${name}.txt`),
      'utf8',
    );
    expect(await render(fixture('inputs', `${name}.json`))).toBe(expected);
  });

  it('has an input file for every expected file', () => {
    const inputs = fs
      .readdirSync(path.join(FIXTURES, 'inputs'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(inputs).toEqual(CASES);
    expect(CASES).toHaveLength(21);
  });
});
