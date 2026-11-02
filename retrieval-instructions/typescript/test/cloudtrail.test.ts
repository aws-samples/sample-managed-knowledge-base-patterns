import { LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { describe, expect, it } from 'vitest';
import { Lookup, PAGE_INTERVAL_S, lookup } from '../src/cloudtrail';
import { FakeCloudTrail, NOW, fakeClient, noSleep } from './support';

const ID_TO_KEY = new Map([
  ['abcde12345', 'sales-region-north'],
  ['fghij67890', 'team-support'],
]);

describe('cloudtrail', () => {
  it('keeps only service-invoked calls for sample IDs, with DRAFT for no version', async () => {
    const [rows, streams] = await lookup(
      new Lookup(new FakeCloudTrail().client(), noSleep),
      ID_TO_KEY,
      60,
      NOW,
    );
    expect(rows).toEqual([
      {
        time: '2026-10-01T12:02:00Z',
        tenant: 'team-support',
        version: '2',
        role: 'ExampleApplierRole',
        error: 'AccessDenied',
      },
      {
        time: '2026-10-01T12:05:00Z',
        tenant: 'sales-region-north',
        version: '1',
        role: 'ExampleOperatorRole',
        error: 'none',
      },
      {
        time: '2026-10-01T12:20:00Z',
        tenant: 'team-support',
        version: 'DRAFT',
        role: 'ExampleOperatorRole',
        error: 'none',
      },
    ]);
    expect(streams).toBe(2);
  });

  it('paginates with a pause between requests', async () => {
    const sleeps: number[] = [];
    const trail = new FakeCloudTrail();
    const pause = (seconds: number): Promise<void> => {
      sleeps.push(seconds);
      return Promise.resolve();
    };
    await lookup(new Lookup(trail.client(), pause), ID_TO_KEY, 30, NOW);
    expect(trail.calls).toHaveLength(4); // two pages for each event name
    expect(sleeps).toEqual(Array(3).fill(PAGE_INTERVAL_S));
    const first = trail.calls[0] ?? {};
    expect(first.LookupAttributes).toEqual([
      { AttributeKey: 'EventName', AttributeValue: 'GetRetrievalInstruction' },
    ]);
    expect(first.StartTime).toEqual(new Date(NOW.getTime() - 30 * 60_000));
    expect(first.EndTime).toEqual(NOW);
    expect(first.MaxResults).toBe(50);
    expect(trail.calls[1]?.NextToken).toBe('example-next-token');
  });

  it('sends LookupEventsCommand through the paginator', async () => {
    const commands: unknown[] = [];
    const client = fakeClient(new FakeCloudTrail().client(), (command) => {
      commands.push(command);
      return Promise.resolve({ Events: [] });
    });
    await new Lookup(client, noSleep).events('GetRetrievalInstruction', NOW, NOW);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(LookupEventsCommand);
  });
});
