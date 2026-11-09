import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageError } from '../src/errors';
import * as stateFile from '../src/state';
import { ACCOUNT, FIXTURES, fixture, tempDir, writeState } from './support';

// A failed rename for the atomic-write test. src/state.ts gets this module in place of node:fs.
const failRename = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (failRename.on) throw new Error('disk full');
      return actual.renameSync(...args);
    },
  };
});

const TEXT = fs.readFileSync(path.join(FIXTURES, 'state.json'), 'utf8');
const ARN = `arn:aws:bedrock:us-east-1:${ACCOUNT}:retrieval-instruction/`;

let dir = '';
let cleanup = (): void => undefined;
beforeEach(() => {
  [dir, cleanup] = tempDir();
});
afterEach(() => {
  failRename.on = false;
  cleanup();
});

const statePath = (): string => path.join(dir, 'sample-state.json');

function loaded(file: string): stateFile.State {
  const s = stateFile.load(file);
  if (s === null) throw new Error('expected a state file');
  return s;
}

describe('state file', () => {
  it('rewrites the fixture byte-identically', () => {
    const s = loaded(writeState(statePath()));
    expect(stateFile.dumps(s)).toBe(TEXT);
    expect(s.release['team-support']?.canary).toBeDefined();
    const support = s.instructions['team-support'];
    expect(support && stateFile.latest(support)).toBe('2');
  });

  it('writes atomically and sets the writer', () => {
    const file = writeState(statePath());
    stateFile.save(loaded(file), file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).updatedBy).toBe('typescript');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('leaves the file unchanged when a write fails', () => {
    const file = writeState(statePath());
    const s = loaded(file);
    s.region = 'eu-west-1';
    failRename.on = true;
    expect(() => stateFile.save(s, file)).toThrow('disk full');
    expect(fs.readFileSync(file, 'utf8')).toBe(TEXT);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('returns null for a missing file', () => {
    expect(stateFile.load(statePath())).toBeNull();
  });

  type Raw = ReturnType<typeof fixture>;
  const support = (r: Raw): Raw => r.instructions['team-support'];
  it.each<[string, (r: Raw) => void]>([
    ['schemaVersion 2', (r) => (r.schemaVersion = 2)],
    ['short account', (r) => (r.account = '12345')],
    ['unknown writer', (r) => (r.updatedBy = 'ruby')],
    ['extra key', (r) => (r.extra = true)],
    ['wrong name', (r) => (support(r).name = 'assistant-other')],
    ['uppercase id', (r) => (support(r).id = 'ABCDE12345')],
    ['arn for another id', (r) => (support(r).arn = ARN + 'zzzzz00000')],
    ['versions out of order', (r) => (support(r).versions = ['2', '1'])],
    ['unknown creator', (r) => (support(r).createdBy = 'java')],
    ['extra entry field', (r) => (support(r).secret = 'x')],
    ['live not recorded', (r) => (r.release['team-support'].live = '3')],
    ['canary every 0', (r) => (r.release['team-support'].canary.every = 0)],
    ['canary every true', (r) => (r.release['team-support'].canary.every = true)],
    [
      'release without instruction',
      (r) => (r.release['sales-region-south'] = { live: '1' }),
    ],
  ])('rejects a schema error: %s', (_, change) => {
    const raw = fixture('state.json');
    change(raw);
    let caught: unknown;
    try {
      stateFile.parse(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).exitCode).toBe(2);
    expect((caught as UsageError).message).toContain("isn't a valid state file");
  });

  it('rejects a file that is not JSON', () => {
    fs.writeFileSync(statePath(), '{', 'utf8');
    expect(() => stateFile.load(statePath())).toThrow(UsageError);
  });

  it('checks the account and Region', () => {
    const s = stateFile.parse(fixture('state.json'));
    stateFile.checkEnvironment(s, ACCOUNT, 'us-east-1');
    expect(() => stateFile.checkEnvironment(s, ACCOUNT, 'eu-west-1')).toThrow(
      /us-east-1.*eu-west-1/,
    );
  });

  it('removes an instruction and its release entry in the same write', () => {
    const file = writeState(statePath());
    const s = loaded(file);
    stateFile.removeInstruction(s, 'team-support');
    stateFile.save(s, file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect('team-support' in raw.instructions || 'team-support' in raw.release).toBe(
      false,
    );
    expect(Object.keys(stateFile.parse(raw).instructions)).toEqual([
      'sales-region-north',
    ]);
  });

  it('keeps entries in spec order', () => {
    const s = stateFile.newState(ACCOUNT, 'us-east-1');
    for (const key of ['team-support', 'structured-json', 'sales-region-north']) {
      stateFile.putInstruction(s, key, {
        name: `assistant-${key}`,
        id: 'abcde12345',
        arn: ARN + 'abcde12345',
        versions: [],
        createdBy: 'typescript',
      });
      stateFile.addVersion(s, key, '1');
      stateFile.setRelease(s, key, { live: '1' });
    }
    const order = ['sales-region-north', 'team-support', 'structured-json'];
    expect(Object.keys(s.instructions)).toEqual(order);
    expect(Object.keys(s.release)).toEqual(order);
    stateFile.addVersion(s, 'team-support', '10');
    stateFile.addVersion(s, 'team-support', '2');
    expect(s.instructions['team-support']?.versions).toEqual(['1', '2', '10']);
  });
});
