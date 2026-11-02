import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import {
  canaryText,
  checkedRelease,
  describeRelease,
  versionFor,
} from '../src/release';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('release', () => {
  it('routes everything to live without a canary', () => {
    expect(range(10).map((i) => versionFor({ live: '1' }, i))).toEqual(
      Array(10).fill('1'),
    );
  });

  it('sends one request in every to the canary', () => {
    const cfg = { live: '1', canary: { version: '2', every: 5 } };
    expect(range(10).map((i) => versionFor(cfg, i))).toEqual([
      '2',
      '1',
      '1',
      '1',
      '1',
      '2',
      '1',
      '1',
      '1',
      '1',
    ]);
  });

  it('sends everything to the canary with every 1', () => {
    const cfg = { live: '1', canary: { version: '2', every: 1 } };
    expect(new Set(range(10).map((i) => versionFor(cfg, i)))).toEqual(new Set(['2']));
  });

  it('promotes and rolls back', () => {
    expect(versionFor({ live: '2' }, 3)).toBe('2');
    expect(versionFor({ live: '1' }, 3)).toBe('1');
  });

  it('describes the configuration', () => {
    const cfg = { live: '1', canary: { version: '2', every: 5 } };
    expect(canaryText(cfg)).toBe('2 (1 in 5)');
    expect(describeRelease(cfg)).toBe('live 1, canary 2 (1 in 5)');
    expect(describeRelease({ live: '1' })).toBe('live 1, no canary');
    expect(canaryText(undefined)).toBe('none');
  });

  it('accepts recorded versions in release set', () => {
    expect(checkedRelease('n', ['1', '2'], '2', undefined, undefined)).toEqual({
      live: '2',
    });
    expect(checkedRelease('n', ['1', '2'], '1', '2', 5)).toEqual({
      live: '1',
      canary: { version: '2', every: 5 },
    });
  });

  it.each<[string, string | undefined, number | undefined, string]>([
    ['3', undefined, undefined, "isn't recorded"],
    ['1', '3', 5, "isn't recorded"],
    ['v1', undefined, undefined, "isn't a version number"],
    ['1', '2', undefined, '--canary needs --every'],
    ['1', undefined, 5, '--every needs --canary'],
    ['1', '2', 0, '--every must be 1 or more'],
  ])('rejects live %s canary %s every %s', (live, canary, every, problem) => {
    const run = (): unknown =>
      checkedRelease('assistant-team-support', ['1', '2'], live, canary, every);
    expect(run).toThrow(UsageError);
    expect(run).toThrow(problem);
  });
});
