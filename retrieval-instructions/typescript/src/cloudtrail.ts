/**
 * Which tenant instruction and version Amazon Bedrock read, from CloudTrail event history.
 *
 * When a request applies a retrieval instruction, Amazon Bedrock calls GetRetrievalInstruction on
 * the caller's behalf. Event history can show that management event with
 * `invokedBy: bedrock.amazonaws.com`, the instruction ID, and the version (none for DRAFT), as it
 * did when the sample was tested. AgenticRetrieveStream is a data event, which event history
 * doesn't hold; a trail records it only after you enable data events.
 */

import {
  type CloudTrailClient,
  paginateLookupEvents,
} from '@aws-sdk/client-cloudtrail';
import { pyStr } from './output';
import { type Sleep, sleep as defaultSleep } from './poll';

export const PAGE_INTERVAL_S = 0.6; // LookupEvents allows 2 requests per second per account and Region
const BEDROCK = 'bedrock.amazonaws.com';

export interface CallRow {
  time: string;
  tenant: string;
  version: string;
  role: string;
  error: string;
}

type CloudTrailRecord = Record<string, unknown>;

/** LookupEvents by event name, paginated, with a pause before every request after the first. */
export class Lookup {
  requests = 0;

  constructor(
    readonly cloudtrail: CloudTrailClient,
    readonly sleep: Sleep = defaultSleep,
  ) {}

  async events(eventName: string, start: Date, end: Date): Promise<CloudTrailRecord[]> {
    const records: CloudTrailRecord[] = [];
    if (this.requests) await this.sleep(PAGE_INTERVAL_S);
    const pages = paginateLookupEvents(
      { client: this.cloudtrail, pageSize: 50 },
      {
        LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: eventName }],
        StartTime: start,
        EndTime: end,
        MaxResults: 50,
      },
    );
    for await (const page of pages) {
      this.requests += 1;
      for (const e of page.Events ?? []) {
        records.push(JSON.parse(e.CloudTrailEvent ?? '{}') as CloudTrailRecord);
      }
      if (page.NextToken) await this.sleep(PAGE_INTERVAL_S); // before the next page's request
    }
    return records;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Service-invoked GetRetrievalInstruction calls for the sample's instructions, oldest first. */
export function callRows(
  records: readonly CloudTrailRecord[],
  idToKey: ReadonlyMap<string, string>,
): CallRow[] {
  const rows: CallRow[] = [];
  for (const record of records) {
    const identity = record.userIdentity;
    const params = record.requestParameters;
    const key = idToKey.get(pyStr(field(params, 'retrievalInstructionId')));
    if (
      record.eventName !== 'GetRetrievalInstruction' ||
      field(identity, 'invokedBy') !== BEDROCK ||
      !key
    ) {
      continue;
    }
    const issuer = field(field(identity, 'sessionContext'), 'sessionIssuer');
    rows.push({
      time: pyStr(record.eventTime),
      tenant: key,
      version: pyStr(field(params, 'retrievalInstructionVersion') || 'DRAFT'),
      role: pyStr(field(issuer, 'userName') || '-'),
      error: pyStr(record.errorCode || 'none'),
    });
  }
  return rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** The matching GetRetrievalInstruction rows and the AgenticRetrieveStream event count for the window. */
export async function lookup(
  client: Lookup,
  idToKey: ReadonlyMap<string, string>,
  sinceMinutes: number,
  now: Date,
): Promise<[CallRow[], number]> {
  const start = new Date(now.getTime() - sinceMinutes * 60_000);
  const rows = callRows(
    await client.events('GetRetrievalInstruction', start, now),
    idToKey,
  );
  const streams = (await client.events('AgenticRetrieveStream', start, now)).filter(
    (r) => r.eventName === 'AgenticRetrieveStream',
  );
  return [rows, streams.length];
}
