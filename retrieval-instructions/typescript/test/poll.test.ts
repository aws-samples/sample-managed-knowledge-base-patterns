import { GetRetrievalInstructionCommand } from '@aws-sdk/client-bedrock-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { reasons, waitForReview } from '../src/poll';
import { NOW, Script, capture, clock, noSleep } from './support';

const ID = 'abcde12345';
const ARN = `arn:aws:bedrock:us-east-1:123456789012:retrieval-instruction/${ID}`;
const REASONS = [
  { fieldName: 'persona', code: 'CONTENT_FLAGGED', message: 'content flagged' },
];

function get(status: string, transition: string, extra: object = {}): object {
  return {
    retrievalInstructionId: ID,
    retrievalInstructionArn: ARN,
    name: 'assistant-sales-region-north',
    status,
    lastTransitionStatus: transition,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function queue(script: Script, ...responses: object[]): Script {
  for (const r of responses) {
    script.add(GetRetrievalInstructionCommand, r, { retrievalInstructionId: ID });
  }
  return script;
}

let io: ReturnType<typeof capture> | undefined;
afterEach(() => io?.restore());

describe('waitForReview', () => {
  it('polls until the review finishes', async () => {
    io = capture();
    const script = queue(
      new Script(),
      get('INACTIVE', 'CREATING'),
      get('INACTIVE', 'CREATING'),
      get('ACTIVE', 'CREATE_SUCCESSFUL'),
    );
    const review = await waitForReview(script.agent(), ID, {
      sleep: noSleep,
      clock: clock(),
    });
    expect([
      review.final.status,
      review.final.lastTransitionStatus,
      review.timedOut,
    ]).toEqual(['ACTIVE', 'CREATE_SUCCESSFUL', false]);
    expect(io.err()).toContain('waiting for review: CREATING');
    script.assertDone();
  });

  it('times out', async () => {
    io = capture();
    const script = queue(
      new Script(),
      get('INACTIVE', 'UPDATING'),
      get('INACTIVE', 'UPDATING'),
    );
    const review = await waitForReview(script.agent(), ID, {
      timeoutS: 3,
      sleep: noSleep,
      clock: clock(2),
    });
    expect(review.timedOut).toBe(true);
    script.assertDone();
  });

  it('surfaces the reasons', async () => {
    const script = queue(
      new Script(),
      get('INACTIVE', 'CREATE_FAILED', { lastTransitionStatusReasons: REASONS }),
    );
    const review = await waitForReview(script.agent(), ID, {
      sleep: noSleep,
      clock: clock(),
    });
    expect(reasons(review.final)).toEqual([
      'persona: CONTENT_FLAGGED: content flagged',
    ]);
  });
});
