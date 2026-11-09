/** Shared helpers: the test-fixtures directory, fake clients, and stream fakes. No test calls AWS. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import {
  AccessDeniedException,
  type AgenticRetrieveStreamResponseOutput,
  BedrockAgentRuntimeClient,
  BedrockAgentRuntimeServiceException,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { expect, vi } from 'vitest';
import type { StreamResponse } from '../src/ask';
import { PATTERN_ROOT } from '../src/paths';

export const FIXTURES = path.join(PATTERN_ROOT, 'test-fixtures');
export const ACCOUNT = '123456789012';
export const NOW = new Date(Date.UTC(2026, 9, 1, 12, 0));
const CREDENTIALS = { accessKeyId: 'testing', secretAccessKey: 'testing' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixtures are untyped JSON
export function fixture(...parts: string[]): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8'));
}

/** An error shaped like the SDK's modeled service exceptions. */
export function serviceError(name: string, message = 'message'): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { requestId: 'req' },
  });
}

/** What a fake client's send() received: the command class and a copy of its input. */
export interface Sent {
  command: object;
  input: Record<string, unknown>;
}

type Send = (command: { input: object }) => Promise<unknown>;

function sent(command: { input: object }): Sent {
  return { command, input: { ...(command.input as Record<string, unknown>) } };
}

/** A real client whose send() is replaced by `send`, so paginators and instanceof checks work. */
export function fakeClient<T extends object>(client: T, send: Send): T {
  return Object.assign(client, { send });
}

/**
 * Expected calls in order, like botocore's Stubber: each call must use the queued command class
 * and, when given, exactly the queued input. Unqueued calls fail the test.
 */
export class Script {
  readonly calls: Sent[] = [];
  private readonly queue: {
    ctor: abstract new (...args: never[]) => object;
    output?: unknown;
    error?: Error;
    input?: object;
  }[] = [];

  add(
    ctor: abstract new (...args: never[]) => object,
    output: unknown,
    input?: object,
  ): this {
    this.queue.push({ ctor, output, input });
    return this;
  }

  fail(
    ctor: abstract new (...args: never[]) => object,
    error: Error,
    input?: object,
  ): this {
    this.queue.push({ ctor, error, input });
    return this;
  }

  readonly send: Send = (command) => {
    this.calls.push(sent(command));
    const next = this.queue.shift();
    if (next === undefined)
      throw new Error(`unexpected call: ${command.constructor.name}`);
    expect(command).toBeInstanceOf(next.ctor);
    if (next.input !== undefined) expect(command.input).toEqual(next.input);
    if (next.error) return Promise.reject(next.error);
    return Promise.resolve(next.output ?? {});
  };

  assertDone(): void {
    expect(this.queue.map((q) => q.ctor.name)).toEqual([]);
  }

  agent(): BedrockAgentClient {
    return fakeClient(
      new BedrockAgentClient({ region: 'us-east-1', credentials: CREDENTIALS }),
      this.send,
    );
  }
}

async function* replay(
  events: Record<string, unknown>[],
): AsyncGenerator<AgenticRetrieveStreamResponseOutput> {
  for (const event of events) {
    const marker = event.raise as { code: string; message: string } | undefined;
    if (marker) {
      const name = marker.code.slice(0, 1).toUpperCase() + marker.code.slice(1);
      if (name === 'AccessDeniedException') {
        throw new AccessDeniedException({ message: marker.message, $metadata: {} });
      }
      throw new BedrockAgentRuntimeServiceException({
        name,
        message: marker.message,
        $fault: 'client',
        $metadata: {},
      });
    }
    yield event as unknown as AgenticRetrieveStreamResponseOutput;
  }
}

/** A response whose stream replays test-fixtures/streams/<name>; a {"raise": ...} marker throws. */
export function streamResponse(name: string): StreamResponse {
  return { stream: replay(fixture('streams', name) as Record<string, unknown>[]) };
}

/** Records each AgenticRetrieveStream input and replays a stream fixture (or throws). */
export class FakeRuntime {
  readonly calls: Record<string, unknown>[] = [];
  private readonly streams: (string | Error)[];

  constructor(...streams: (string | Error)[]) {
    this.streams = streams;
  }

  client(): BedrockAgentRuntimeClient {
    return fakeClient(
      new BedrockAgentRuntimeClient({ region: 'us-east-1', credentials: CREDENTIALS }),
      (command) => {
        this.calls.push(sent(command).input);
        const item = this.streams.shift();
        if (item === undefined) throw new Error('no stream queued');
        if (item instanceof Error) return Promise.reject(item);
        return Promise.resolve(streamResponse(item));
      },
    );
  }
}

/** LookupEvents over the fixture pages, filtered by the EventName lookup attribute. */
export class FakeCloudTrail {
  readonly calls: Record<string, unknown>[] = [];
  private readonly pages: { Events: { EventName: string }[]; NextToken?: string }[];

  constructor(pages: string[] = ['page-1.json', 'page-2.json']) {
    this.pages = pages.map((p) => fixture('cloudtrail', p));
  }

  client(): CloudTrailClient {
    return fakeClient(
      new CloudTrailClient({ region: 'us-east-1', credentials: CREDENTIALS }),
      (command) => {
        const input = sent(command).input;
        this.calls.push(input);
        const page = this.pages[input.NextToken !== undefined ? 1 : 0];
        const attributes = input.LookupAttributes as { AttributeValue: string }[];
        const name = attributes[0]?.AttributeValue;
        return Promise.resolve({
          Events: (page?.Events ?? []).filter((e) => e.EventName === name),
          NextToken: page?.NextToken,
        });
      },
    );
  }
}

export const noSleep = (): Promise<void> => Promise.resolve();

/** A clock that advances by `step` seconds on each read. */
export function clock(step = 1): () => number {
  let t = 0;
  return () => (t += step);
}

/** A temporary directory, removed by the returned cleanup function. */
export function tempDir(): [string, () => void] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-sample-test-'));
  return [dir, () => fs.rmSync(dir, { recursive: true, force: true })];
}

export function writeState(file: string, name = 'state.json'): string {
  fs.writeFileSync(file, fs.readFileSync(path.join(FIXTURES, name), 'utf8'), 'utf8');
  return file;
}

/** Capture stdout and stderr writes until restore(). */
export function capture(): {
  out: () => string;
  err: () => string;
  restore: () => void;
} {
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const text = (spy: typeof outSpy): string =>
    spy.mock.calls.map((c) => String(c[0])).join('');
  return {
    out: () => text(outSpy),
    err: () => text(errSpy),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}
