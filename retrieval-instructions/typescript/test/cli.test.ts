/** The command line: help, abbreviations, exit codes per error class, and the release commands. */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli';
import type { Context } from '../src/commands';
import { OUTPUT_KEYS, STACK_NAME, TENANT_OUTPUT_PREFIXES } from '../src/deployment';
import { PATTERN_ROOT } from '../src/paths';
import {
  ACCOUNT,
  FakeRuntime,
  capture,
  fixture,
  noSleep,
  serviceError,
  tempDir,
  writeState,
} from './support';

// The release commands use the default state file path; point it at a temporary file.
const paths = vi.hoisted(() => ({ state: '' }));
vi.mock('../src/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/paths')>();
  return {
    ...actual,
    get STATE_FILE() {
      return paths.state;
    },
  };
});

const COMMANDS = [
  ['status'],
  ['create-instructions'],
  ['baseline'],
  ['ask'],
  ['isolation'],
  ['structured-json'],
  ['multi-kb'],
  ['support-v2'],
  ['release', 'show'],
  ['release', 'set'],
  ['release', 'route'],
  ['cloudtrail'],
  ['verify-abac'],
  ['teardown'],
];
const OUTPUTS = {
  SharedKnowledgeBaseId: 'ABCDE12345',
  SharedDataSourceId: 'KLMNO12345',
  CorpusBucketName: 'bucket',
};

let io: ReturnType<typeof capture>;
let dir = '';
let cleanup = (): void => undefined;
beforeEach(() => {
  io = capture();
  [dir, cleanup] = tempDir();
  paths.state = path.join(dir, 'sample-state.json');
});
afterEach(() => {
  io.restore();
  cleanup();
});

function sts(fail?: Error): unknown {
  return {
    send: () => (fail ? Promise.reject(fail) : Promise.resolve({ Account: ACCOUNT })),
  };
}

function cloudformation(missing = false): unknown {
  return {
    send: (command: { input: { StackName?: string } }) => {
      expect(command.input.StackName).toBe(STACK_NAME);
      if (missing) {
        return Promise.reject(
          serviceError('ValidationError', `Stack with id ${STACK_NAME} does not exist`),
        );
      }
      const outputs = Object.entries(OUTPUTS).map(([k, v]) => ({
        OutputKey: k,
        OutputValue: v,
      }));
      return Promise.resolve({
        Stacks: [
          { StackName: STACK_NAME, StackStatus: 'CREATE_COMPLETE', Outputs: outputs },
        ],
      });
    },
  };
}

function context(overrides: Partial<Record<keyof Context, unknown>> = {}): Context {
  return {
    agent: null,
    runtime: new FakeRuntime().client(),
    sts: sts(),
    cloudformation: cloudformation(),
    cloudtrail: null,
    region: 'us-east-1',
    clientFactory: null,
    statePath: paths.state,
    sleep: noSleep,
    clock: () => 0,
    now: () => new Date(),
    ...overrides,
  } as unknown as Context;
}

const run = (argv: string[], ctx: Context): Promise<number> =>
  main(argv, () => Promise.resolve(ctx));

describe('cli', () => {
  it.each(COMMANDS.map((c) => [c.join(' '), c] as const))(
    '%s has help',
    async (_, command) => {
      expect(await main([...command, '--help'])).toBe(0);
      expect(io.out()).toContain('usage: ri-sample');
    },
  );

  it('prints top-level help, also from the script entry point', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(await main(['-h'])).toBe(0);
    const tsx = path.join(PATTERN_ROOT, 'node_modules', '.bin', 'tsx');
    const done = spawnSync(
      tsx,
      [path.join(PATTERN_ROOT, 'typescript', 'src', 'cli.ts'), '--help'],
      {
        encoding: 'utf8',
      },
    );
    expect(done.status).toBe(0);
    expect(done.stdout).toContain('<command>');
  });

  it.each([
    [['ask', '--ques', 'x']],
    [['ask', '--tenant', 'sales-region-north', '--quest', 'x']],
    [['release', 'route', '--ten', 'team-support']],
    [
      [
        'ask',
        '--tenant',
        'team-support',
        '--question',
        'x',
        '--version',
        '1',
        '--request-index',
        '0',
      ],
    ],
    [['status', '--quota', 'many']],
    [['nonsense']],
    [[]],
    [['release']],
    [['ask', '--tenant', 'team-support']],
    [['status', 'extra']],
  ])('exits 2 for the usage error %j', async (argv) => {
    expect(await main(argv)).toBe(2);
    expect(io.err()).toContain('error:');
  });

  it('keeps the output keys equal to the constants', () => {
    const constants = fixture('constants.json');
    expect(constants.stackName).toBe(STACK_NAME);
    expect(OUTPUT_KEYS).toEqual(constants.outputKeys);
    expect(TENANT_OUTPUT_PREFIXES).toEqual(constants.tenantOutputPrefixes);
  });

  it('exits 3 without credentials', async () => {
    const noCredentials = Object.assign(new Error('Could not load credentials'), {
      name: 'CredentialsProviderError',
    });
    expect(await run(['status'], context({ sts: sts(noCredentials) }))).toBe(3);
    expect(io.err()).toContain('error: no valid AWS credentials');
  });

  it('exits 2 for a missing stack', async () => {
    expect(
      await run(
        ['baseline', '--question', 'x'],
        context({ cloudformation: cloudformation(true) }),
      ),
    ).toBe(2);
    expect(io.err()).toContain(`stack ${STACK_NAME} not found in us-east-1`);
  });

  it('exits 2 for a state file from another Region', async () => {
    const ctx = context({ region: 'eu-west-1' });
    writeState(ctx.statePath);
    expect(
      await run(['ask', '--tenant', 'sales-region-north', '--question', 'x'], ctx),
    ).toBe(2);
    expect(io.err()).toContain('eu-west-1');
  });

  it('exits 1 for an isolation leak', async () => {
    const runtime = new FakeRuntime(
      'isolation-unfiltered.json',
      'isolation-unfiltered.json',
    );
    const ctx = context({ runtime: runtime.client() });
    writeState(ctx.statePath);
    expect(
      await run(
        ['isolation', '--tenant', 'sales-region-north', '--question', 'x'],
        ctx,
      ),
    ).toBe(1);
    expect(io.out()).toContain('Result: FAIL');
  });

  it('exits 3 for an AWS error, with the request ID', async () => {
    const runtime = new FakeRuntime(serviceError('ThrottlingException', 'slow down'));
    expect(
      await run(
        ['baseline', '--question', 'x'],
        context({ runtime: runtime.client() }),
      ),
    ).toBe(3);
    expect(io.err()).toContain(
      'error: ThrottlingException: slow down (request ID req)',
    );
  });

  it('exits 3 for an in-stream exception', async () => {
    const ctx = context({ runtime: new FakeRuntime('midstream-error.json').client() });
    writeState(ctx.statePath);
    expect(await run(['ask', '--tenant', 'team-support', '--question', 'x'], ctx)).toBe(
      3,
    );
    expect(io.err()).toContain('error: AccessDeniedException:');
  });

  it('exits 3 for a stream read timeout', async () => {
    const timeout = Object.assign(new Error('socket timed out'), {
      name: 'TimeoutError',
    });
    const ctx = context({ runtime: new FakeRuntime(timeout).client() });
    expect(await run(['baseline', '--question', 'x'], ctx)).toBe(3);
    expect(io.err()).toContain('no data from the service for 120 s');
  });

  it('exits 1 for no answer', async () => {
    const ctx = context({ runtime: new FakeRuntime('empty-answer.json').client() });
    writeState(ctx.statePath);
    expect(
      await run(['ask', '--tenant', 'sales-region-north', '--question', 'x'], ctx),
    ).toBe(1);
  });

  it('sends the snippet request and checks the applied instruction', async () => {
    const runtime = new FakeRuntime('ask-team.json');
    const ctx = context({ runtime: runtime.client() });
    writeState(ctx.statePath);
    const argv = ['ask', '--tenant', 'team-support', '--question', 'x'];
    expect(await run([...argv, '--request-index', '0'], ctx)).toBe(0);
    expect(runtime.calls[0]?.retrievalInstructionConfiguration).toEqual({
      retrievalInstructionId: 'fghij67890',
      version: '2',
    });
    expect(io.out()).toContain('(routed by the release configuration, request 0)');
    const live = new FakeRuntime('ask-team.json');
    expect(await run(argv, context({ runtime: live.client() }))).toBe(1);
  });

  it('runs the release commands without AWS', async () => {
    writeState(paths.state);
    expect(
      await main(['release', 'set', '--tenant', 'team-support', '--live', '2']),
    ).toBe(0);
    expect(io.out()).toContain('Release for team-support: live 2, no canary');
    expect(JSON.parse(fs.readFileSync(paths.state, 'utf8')).updatedBy).toBe(
      'typescript',
    );
    expect(
      await main(['release', 'set', '--tenant', 'team-support', '--live', '3']),
    ).toBe(2);
    expect(
      await main(['release', 'route', '--tenant', 'team-support', '--requests', '0']),
    ).toBe(2);
    expect(await main(['release', 'show'])).toBe(0);
  });

  it('prints the teardown plan without --yes and deletes nothing', async () => {
    const agent = {
      send: () => Promise.resolve({ retrievalInstructionSummaries: [] }),
    };
    expect(await run(['teardown'], context({ agent }))).toBe(0);
    expect(io.out()).toBe('No sample instructions found in this Region.\n');
  });
});
