import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CreateRetrievalInstructionCommand,
  CreateRetrievalInstructionVersionCommand,
  DeleteRetrievalInstructionCommand,
  GetRetrievalInstructionCommand,
  ListRetrievalInstructionVersionsCommand,
  ListRetrievalInstructionsCommand,
  ListTagsForResourceCommand,
  UpdateRetrievalInstructionCommand,
} from '@aws-sdk/client-bedrock-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli';
import type { Context } from '../src/commands';
import { AwsError, CheckFailed, UsageError } from '../src/errors';
import {
  type CreateOutcome,
  candidate,
  candidates,
  createAndPin,
  createInstructions,
  deleteInstruction,
  inspect,
  listInstructions,
  quotaCheck,
  updateAnswerFormat,
} from '../src/instructions';
import { type Review, type Wait, waitForReview } from '../src/poll';
import { type Spec, specFor } from '../src/specs';
import * as stateFile from '../src/state';
import type { State } from '../src/state';
import {
  ACCOUNT,
  FakeRuntime,
  NOW,
  Script,
  capture,
  clock,
  fixture,
  noSleep,
  serviceError,
  tempDir,
  writeState,
} from './support';

const ID = 'abcde12345';
const ARN = `arn:aws:bedrock:us-east-1:${ACCOUNT}:retrieval-instruction/${ID}`;
const NAME = 'assistant-sales-region-north';
const REASONS = [
  { fieldName: 'persona', code: 'CONTENT_FLAGGED', message: 'content flagged' },
];
const CONTENT = {
  persona: 'You are a demo assistant.',
  answerFormat: 'Two sentences.',
};
const APP_TAGS = { tenant: 'sales-region-north', app: 'retrieval-instructions-sample' };

let io: ReturnType<typeof capture>;
beforeEach(() => {
  io = capture();
});
afterEach(() => io.restore());

function north(): Spec {
  const spec = specFor('sales-region-north');
  if (spec === undefined) throw new Error('missing spec');
  return spec;
}

const wait: Wait = (agent, instructionId, options = {}): Promise<Review> =>
  waitForReview(agent, instructionId, {
    first: options.first,
    sleep: noSleep,
    clock: clock(),
  });

function described(status: string, transition: string, extra: object = {}): object {
  return {
    retrievalInstructionId: ID,
    retrievalInstructionArn: ARN,
    name: NAME,
    status,
    lastTransitionStatus: transition,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

const notFound = (): Error => serviceError('ResourceNotFoundException', 'gone');

function get(
  script: Script,
  status: string,
  transition: string,
  extra: object = {},
): void {
  script.add(GetRetrievalInstructionCommand, described(status, transition, extra), {
    retrievalInstructionId: ID,
  });
}

function version(script: Script, v: string): void {
  script.add(
    CreateRetrievalInstructionVersionCommand,
    {
      retrievalInstructionId: ID,
      retrievalInstructionArn: ARN,
      version: v,
      createdAt: NOW,
    },
    { retrievalInstructionId: ID },
  );
}

function tags(script: Script, values: Record<string, string> = APP_TAGS): void {
  script.add(ListTagsForResourceCommand, { tags: values }, { resourceArn: ARN });
}

function listed(script: Script, names: string[], token?: string, after?: string): void {
  const page: Record<string, unknown> = {
    retrievalInstructionSummaries: names.map((n, i) => ({
      retrievalInstructionId: `id${String(i).padStart(8, '0')}`,
      retrievalInstructionArn: `${ARN.slice(0, -10)}id${String(i).padStart(8, '0')}`,
      name: n,
      status: 'ACTIVE',
      lastTransitionStatus: 'CREATE_SUCCESSFUL',
      createdAt: NOW,
      updatedAt: NOW,
    })),
  };
  if (token) page.nextToken = token;
  script.add(
    ListRetrievalInstructionsCommand,
    page,
    after ? { maxResults: 50, nextToken: after } : { maxResults: 50 },
  );
}

function recorded(versions: string[] = []): State {
  const s = stateFile.newState(ACCOUNT, 'us-east-1');
  stateFile.putInstruction(s, 'sales-region-north', {
    name: NAME,
    id: ID,
    arn: ARN,
    versions,
    createdBy: 'typescript',
  });
  const newest = versions.at(-1);
  if (newest) stateFile.setRelease(s, 'sales-region-north', { live: newest });
  return s;
}

async function runCreate(
  script: Script,
  s: State,
  specs: Spec[] = [north()],
): Promise<CreateOutcome[]> {
  const outcomes: CreateOutcome[] = [];
  const saves: string[] = [];
  await createInstructions(
    script.agent(),
    s,
    specs,
    outcomes,
    (st) => saves.push(stateFile.dumps(st)),
    'typescript',
    wait,
  );
  script.assertDone();
  return outcomes;
}

async function rejects<T extends Error>(
  promise: Promise<unknown>,
  type: new (...a: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as T;
  }
  throw new Error(`expected ${type.name}`);
}

describe('create and recover', () => {
  it('records, waits, and versions', async () => {
    const script = new Script();
    script.add(CreateRetrievalInstructionCommand, described('INACTIVE', 'CREATING'), {
      name: NAME,
      instruction: CONTENT,
      description: 'd',
      tags: APP_TAGS,
    });
    get(script, 'INACTIVE', 'CREATING');
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL');
    version(script, '1');
    const records: [string, string][] = [];
    const v = await createAndPin(
      script.agent(),
      'sales-region-north',
      CONTENT,
      'd',
      (i, a) => records.push([i, a]),
      wait,
    );
    expect(v).toBe('1');
    expect(records).toEqual([[ID, ARN]]);
    script.assertDone();
  });

  it('keeps the record after a failed review and surfaces the reasons', async () => {
    const script = new Script();
    script.add(CreateRetrievalInstructionCommand, described('INACTIVE', 'CREATING'));
    get(script, 'INACTIVE', 'CREATE_FAILED', { lastTransitionStatusReasons: REASONS });
    const s = stateFile.newState(ACCOUNT, 'us-east-1');
    const err = await rejects(runCreate(script, s), CheckFailed);
    expect(err.message).toContain('persona: CONTENT_FLAGGED: content flagged');
    expect(s.instructions['sales-region-north']?.versions).toEqual([]); // recorded for teardown and recovery
    expect('sales-region-north' in s.release).toBe(false);
  });

  it('stops at the first failed review', async () => {
    const script = new Script();
    script.add(CreateRetrievalInstructionCommand, described('INACTIVE', 'CREATING'));
    get(script, 'INACTIVE', 'CREATE_FAILED');
    const central = specFor('sales-region-central');
    if (central === undefined) throw new Error('missing spec');
    // No create for central is queued, so a second create would fail the script.
    await rejects(
      runCreate(script, stateFile.newState(ACCOUNT, 'us-east-1'), [north(), central]),
      CheckFailed,
    );
  });

  it('skips a finished key', async () => {
    const script = new Script();
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL');
    tags(script);
    expect((await runCreate(script, recorded(['1']))).map((o) => o.result)).toEqual([
      'already created',
    ]);
  });

  it('waits out a running review', async () => {
    const script = new Script();
    get(script, 'INACTIVE', 'CREATING');
    tags(script);
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL');
    expect((await runCreate(script, recorded(['1']))).map((o) => o.result)).toEqual([
      'already created',
    ]);
  });

  it('records the versions of an active key without them', async () => {
    const script = new Script();
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL');
    tags(script);
    script.add(
      ListRetrievalInstructionVersionsCommand,
      {
        retrievalInstructionVersionSummaries: [
          { version: '2', createdAt: NOW },
          { version: '1', createdAt: NOW },
        ],
      },
      { retrievalInstructionId: ID },
    );
    const [outcome] = await runCreate(script, recorded());
    expect([outcome?.result, outcome?.versions, outcome?.live]).toEqual([
      'versions recorded',
      ['1', '2'],
      '2',
    ]);
  });

  it('creates version 1 for an active key with no versions at all', async () => {
    const script = new Script();
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL');
    tags(script);
    script.add(
      ListRetrievalInstructionVersionsCommand,
      { retrievalInstructionVersionSummaries: [] },
      { retrievalInstructionId: ID },
    );
    version(script, '1');
    const [outcome] = await runCreate(script, recorded());
    expect([outcome?.result, outcome?.live]).toEqual(['version created', '1']);
  });

  it('updates a rejected key in place with the current spec', async () => {
    const script = new Script();
    get(script, 'INACTIVE', 'CREATE_FAILED');
    tags(script);
    script.add(UpdateRetrievalInstructionCommand, described('INACTIVE', 'UPDATING'), {
      retrievalInstructionId: ID,
      instruction: north().instruction,
      description: north().description,
    });
    get(script, 'INACTIVE', 'UPDATING');
    get(script, 'ACTIVE', 'UPDATE_SUCCESSFUL');
    version(script, '1');
    const [outcome] = await runCreate(script, recorded());
    expect([outcome?.result, outcome?.versions, outcome?.live]).toEqual([
      'recovered',
      ['1'],
      '1',
    ]);
  });

  it('exits 1 on a second failed review and keeps the key', async () => {
    const script = new Script();
    get(script, 'INACTIVE', 'CREATE_FAILED');
    tags(script);
    script.add(UpdateRetrievalInstructionCommand, described('INACTIVE', 'UPDATING'));
    get(script, 'INACTIVE', 'UPDATE_FAILED', { lastTransitionStatusReasons: REASONS });
    const s = recorded();
    const err = await rejects(runCreate(script, s), CheckFailed);
    expect(err.exitCode).toBe(1);
    expect('sales-region-north' in s.instructions).toBe(true);
  });

  it('creates a recorded instruction again when it is gone', async () => {
    const script = new Script();
    script.fail(GetRetrievalInstructionCommand, notFound(), {
      retrievalInstructionId: ID,
    });
    script.add(
      CreateRetrievalInstructionCommand,
      described('ACTIVE', 'CREATE_SUCCESSFUL'),
    );
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL');
    version(script, '1');
    expect((await runCreate(script, recorded(['1']))).map((o) => o.result)).toEqual([
      'created',
    ]);
  });

  it('exits 2 for a wrong tag on a recorded instruction', async () => {
    const script = new Script();
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL');
    tags(script, { tenant: 'sales-region-north' });
    const err = await rejects(runCreate(script, recorded(['1'])), UsageError);
    expect(err.message).toContain('not tagged app=retrieval-instructions-sample');
  });

  it('names the teardown in a quota error from create', async () => {
    const script = new Script();
    script.fail(
      CreateRetrievalInstructionCommand,
      serviceError('ServiceQuotaExceededException', 'quota'),
    );
    const err = await rejects(
      runCreate(script, stateFile.newState(ACCOUNT, 'us-east-1')),
      AwsError,
    );
    expect(err.message).toContain('teardown --yes');
  });

  it('exits 2 before any create for a listed name missing from the state file', () => {
    const summaries = [{ retrievalInstructionId: 'zzzzz00000', name: NAME }] as never[];
    expect(() =>
      quotaCheck(summaries, stateFile.newState(ACCOUNT, 'us-east-1'), [north()], 50),
    ).toThrow('already exists in this Region');
  });

  it.each<[number, number, boolean]>([
    [49, 50, true],
    [50, 50, false],
    [50, 60, true],
  ])('paginates the quota guard (%i of %i)', async (count, quota, ok) => {
    const script = new Script();
    const names = Array.from({ length: count }, (_, i) => `other-${i}`);
    listed(script, names.slice(0, 30), 't');
    listed(script, names.slice(30), undefined, 't');
    const summaries = await listInstructions(script.agent());
    expect(summaries).toHaveLength(count);
    const check = (): number =>
      quotaCheck(summaries, stateFile.newState(ACCOUNT, 'us-east-1'), [north()], quota);
    if (ok) expect(check()).toBe(1);
    else expect(check).toThrow('pass --quota');
  });

  it('resends every field and the description on update', async () => {
    const script = new Script();
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL', {
      instruction: CONTENT,
      description: 'keep me',
    });
    script.add(UpdateRetrievalInstructionCommand, described('ACTIVE', 'UPDATING'), {
      retrievalInstructionId: ID,
      instruction: { ...CONTENT, answerFormat: 'New.' },
      description: 'keep me',
    });
    get(script, 'ACTIVE', 'UPDATING');
    get(script, 'ACTIVE', 'UPDATE_SUCCESSFUL');
    version(script, '2');
    expect(await updateAnswerFormat(script.agent(), ID, 'New.', wait)).toBe('2');
    script.assertDone();
  });

  it('refuses an update without a description', async () => {
    const script = new Script();
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL', { instruction: CONTENT });
    const err = await rejects(
      updateAnswerFormat(script.agent(), ID, 'New.', wait),
      UsageError,
    );
    expect(err.message).toContain('no description');
  });
});

describe('teardown', () => {
  it('deletes versions newest first, then the instruction', async () => {
    const script = new Script();
    listed(script, []);
    get(script, 'ACTIVE', 'UPDATING');
    tags(script);
    script.add(
      ListRetrievalInstructionVersionsCommand,
      {
        retrievalInstructionVersionSummaries: [
          { version: '1', createdAt: NOW },
          { version: '2', createdAt: NOW },
        ],
      },
      { retrievalInstructionId: ID },
    );
    get(script, 'ACTIVE', 'UPDATE_SUCCESSFUL'); // the review is waited out first
    for (const v of ['2', '1']) {
      script.add(
        DeleteRetrievalInstructionCommand,
        { retrievalInstructionId: ID, retrievalInstructionArn: ARN, version: v },
        { retrievalInstructionId: ID, retrievalInstructionVersion: v },
      );
    }
    script.add(
      DeleteRetrievalInstructionCommand,
      { retrievalInstructionId: ID, retrievalInstructionArn: ARN },
      { retrievalInstructionId: ID },
    );
    script.fail(GetRetrievalInstructionCommand, notFound(), {
      retrievalInstructionId: ID,
    });
    const agent = script.agent();
    const cands = [];
    for (const c of await candidates(agent, recorded(['1', '2'])))
      cands.push(await inspect(agent, c));
    const [cand] = cands;
    if (cand === undefined) throw new Error('no candidate');
    expect([cand.action, cand.versions]).toEqual(['delete', ['2', '1']]);
    expect(
      await deleteInstruction(agent, cand, { wait, sleep: noSleep, clock: clock() }),
    ).toBe('deleted');
    script.assertDone();
  });

  it('skips a listed instruction without the sample tag', async () => {
    const script = new Script();
    listed(script, ['assistant-team-support', 'assistant-somebody-else']);
    script.add(
      GetRetrievalInstructionCommand,
      {
        ...described('ACTIVE', 'CREATE_SUCCESSFUL'),
        retrievalInstructionId: 'id00000000',
      },
      {
        retrievalInstructionId: 'id00000000',
      },
    );
    script.add(ListTagsForResourceCommand, { tags: { tenant: 'team-support' } });
    const agent = script.agent();
    const cands = [];
    for (const c of await candidates(agent, null)) cands.push(await inspect(agent, c));
    expect(cands.map((c) => [c.name, c.action, c.reason])).toEqual([
      [
        'assistant-team-support',
        'skip',
        'not tagged app=retrieval-instructions-sample',
      ],
    ]);
    script.assertDone();
  });

  it('marks a recorded instruction that is gone', async () => {
    const script = new Script();
    script.fail(GetRetrievalInstructionCommand, notFound(), {
      retrievalInstructionId: ID,
    });
    const cand = await inspect(
      script.agent(),
      candidate('sales-region-north', NAME, ID, ARN),
    );
    expect(cand.action).toBe('already deleted');
  });

  it('reports a deletion that is not confirmed in 60 s', async () => {
    const script = new Script();
    script.add(
      DeleteRetrievalInstructionCommand,
      { retrievalInstructionId: ID, retrievalInstructionArn: ARN },
      { retrievalInstructionId: ID },
    );
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL');
    get(script, 'ACTIVE', 'CREATE_SUCCESSFUL');
    const cand = candidate('sales-region-north', NAME, ID, ARN, { versions: [] });
    expect(
      await deleteInstruction(script.agent(), cand, {
        wait,
        sleep: noSleep,
        clock: clock(25),
      }),
    ).toBe('unconfirmed');
    script.assertDone();
  });

  it('can use the fixture state for teardown', () => {
    const [dir, cleanup] = tempDir();
    try {
      const s = stateFile.load(writeState(path.join(dir, 'sample-state.json')));
      expect(Object.values(s?.instructions ?? {}).map((e) => e.name)).toEqual([
        NAME,
        'assistant-team-support',
      ]);
      expect(fixture('state.json').release['team-support'].canary.every).toBe(5);
    } finally {
      cleanup();
    }
  });

  it('handles an already-deleted entry without the stack', async () => {
    const [dir, cleanup] = tempDir();
    try {
      const other = 'fghij67890';
      const otherArn = ARN.slice(0, -10) + other;
      const script = new Script();
      script.add(
        ListRetrievalInstructionsCommand,
        { retrievalInstructionSummaries: [] },
        { maxResults: 50 },
      );
      script.fail(GetRetrievalInstructionCommand, notFound(), {
        retrievalInstructionId: ID,
      });
      script.add(
        GetRetrievalInstructionCommand,
        {
          ...described('ACTIVE', 'CREATE_SUCCESSFUL'),
          retrievalInstructionId: other,
          retrievalInstructionArn: otherArn,
          name: 'assistant-team-support',
        },
        { retrievalInstructionId: other },
      );
      script.add(
        ListTagsForResourceCommand,
        { tags: { tenant: 'team-support', app: 'retrieval-instructions-sample' } },
        { resourceArn: otherArn },
      );
      script.add(
        ListRetrievalInstructionVersionsCommand,
        {
          retrievalInstructionVersionSummaries: [
            { version: '1', createdAt: NOW },
            { version: '2', createdAt: NOW },
          ],
        },
        { retrievalInstructionId: other },
      );
      for (const v of ['2', '1']) {
        script.add(
          DeleteRetrievalInstructionCommand,
          {},
          { retrievalInstructionId: other, retrievalInstructionVersion: v },
        );
      }
      script.add(
        DeleteRetrievalInstructionCommand,
        {},
        { retrievalInstructionId: other },
      );
      script.fail(GetRetrievalInstructionCommand, notFound(), {
        retrievalInstructionId: other,
      });
      const ctx = {
        agent: script.agent(),
        runtime: new FakeRuntime().client(),
        sts: { send: () => Promise.resolve({ Account: ACCOUNT }) },
        cloudformation: {
          send: () =>
            Promise.reject(
              serviceError(
                'ValidationError',
                'Stack with id RetrievalInstructionsSample does not exist',
              ),
            ),
        },
        region: 'us-east-1',
        statePath: writeState(path.join(dir, 'sample-state.json')),
        sleep: noSleep,
        clock: clock(),
      } as unknown as Context;
      expect(await main(['teardown', '--yes'], () => Promise.resolve(ctx))).toBe(0);
      script.assertDone();
      expect(io.out()).toBe(
        'assistant-sales-region-north already deleted\n' +
          'assistant-team-support deleted (versions 2, 1)\n' +
          'Deleted 1 instruction. Removed sample-state.json.\n',
      );
      expect(io.err()).toContain(
        'not found in us-east-1; deleting sample instructions anyway',
      );
      expect(fs.existsSync(ctx.statePath)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
