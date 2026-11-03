import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors';
import { PATTERN_ROOT } from '../src/paths';
import {
  SAMPLE_APP,
  SAMPLE_TAG_KEY,
  TENANT_TAG_KEY,
  allSpecs,
  combinedSpecs,
  defaultSpecs,
  instructionName,
  knownNames,
  loadSpecs,
  supportV2,
} from '../src/specs';
import { ANSWER_KEYS } from '../src/structured-json';
import { fixture, tempDir } from './support';

const CONSTANTS = fixture('constants.json');
// The answerFormat text the post shows, joined into one line.
const POST_ANSWER_FORMAT =
  'Reply with exactly one JSON object and nothing else. Do not use markdown, do not use ' +
  'code fences, and do not write any text before or after the object. The object has ' +
  'exactly these five keys and no others: ' +
  '"answer", "sources", "confidence", "followUpQuestion", "outOfScope".';
const GOOD = {
  key: 'sales-region-north',
  kind: 'region',
  description: 'A description',
  instruction: { persona: 'You are a demo assistant.' },
};

let cleanup = (): void => undefined;
afterEach(() => cleanup());

function write(specs: unknown[]): string {
  const [dir, done] = tempDir();
  cleanup = done;
  const file = path.join(dir, 'specs.json');
  fs.writeFileSync(file, JSON.stringify(specs), 'utf8');
  return file;
}

function usageError(fn: () => unknown): UsageError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error('expected a UsageError');
}

describe('specs', () => {
  it('loads the spec files in order', () => {
    expect(defaultSpecs().map((s) => s.key)).toEqual([
      ...CONSTANTS.tenantKeys,
      CONSTANTS.structuredJsonKey,
    ]);
    expect(combinedSpecs().map((s) => s.key)).toEqual(CONSTANTS.combinedKeys);
    expect(allSpecs().map((s) => s.kind)).toEqual([
      ...Array(3).fill('region'),
      ...Array(3).fill('team'),
      'json',
      ...Array(4).fill('combined'),
    ]);
  });

  it('derives names and tags equal to the constants', () => {
    expect(knownNames()).toEqual(CONSTANTS.instructionNames);
    expect(knownNames()).toHaveLength(11);
    expect(instructionName('sales-region-north.team-support')).toBe(
      'assistant-sales-region-north-team-support',
    );
    expect([SAMPLE_TAG_KEY, SAMPLE_APP, TENANT_TAG_KEY]).toEqual([
      CONSTANTS.sampleTagKey,
      CONSTANTS.sampleTagValue,
      CONSTANTS.tenantTagKey,
    ]);
    expect(allSpecs()[0]?.tags).toEqual({
      tenant: 'sales-region-north',
      app: SAMPLE_APP,
    });
  });

  it('keeps the create call tag literal equal to the sample tag', () => {
    const source = fs.readFileSync(
      path.join(PATTERN_ROOT, 'typescript', 'src', 'instructions.ts'),
      'utf8',
    );
    const line = source.split('\n').find((x) => x.includes('tags: {'));
    expect(line?.trim()).toBe(
      "tags: { tenant, app: 'retrieval-instructions-sample' }, // IAM conditions use both tags",
    );
    expect(line).toContain(`${SAMPLE_TAG_KEY}: '${SAMPLE_APP}'`);
  });

  it("uses the post's answerFormat in the structured JSON spec", () => {
    const spec = defaultSpecs().find((s) => s.kind === 'json');
    expect(Object.keys(spec?.instruction ?? {})).toEqual(['answerFormat']);
    expect(spec?.instruction.answerFormat).toBe(POST_ANSWER_FORMAT);
    for (const key of ANSWER_KEYS)
      expect(spec?.instruction.answerFormat).toContain(`"${key}"`);
  });

  it('loads the support v2 spec', () => {
    const v2 = supportV2();
    expect(v2.key).toBe('team-support');
    expect(v2.answerFormat.endsWith('Keep the whole note under 120 words.')).toBe(true);
    expect(v2.answerFormat).toContain('Ticket ref: pending');
  });

  it.each([
    [{ key: 'Sales Region' }, "doesn't match"],
    [{ key: 'a'.repeat(100) }, 'API name pattern'],
    [{ kind: 'other' }, 'kind must be'],
    [{ description: '' }, 'description must be'],
    [{ description: 'x'.repeat(201) }, 'description must be'],
    [{ instruction: {} }, 'needs at least one'],
    [{ instruction: { persona: '   ' } }, 'persona is empty'],
    [{ instruction: { tone: 'x' } }, 'needs at least one'],
    [
      {
        instruction: { persona: 'x'.repeat(12_001), answerPolicy: 'y'.repeat(12_000) },
      },
      'over 24000 characters',
    ],
  ])('rejects an invalid spec %o', (patch, problem) => {
    const err = usageError(() => loadSpecs(write([{ ...GOOD, ...patch }])));
    expect(err.message).toContain(problem);
    expect(err.exitCode).toBe(2);
  });

  it('rejects duplicate keys and bad JSON', () => {
    usageError(() => loadSpecs(write([GOOD, GOOD])));
    const [dir, done] = tempDir();
    cleanup = done;
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{', 'utf8');
    usageError(() => loadSpecs(bad));
  });

  it('keeps every spec within the limits', () => {
    for (const spec of allSpecs()) {
      expect(spec.description.length).toBeGreaterThanOrEqual(1);
      expect(spec.description.length).toBeLessThanOrEqual(200);
      expect(spec.description).not.toContain('Track');
      const total = Object.values(spec.instruction).reduce((n, v) => n + v.length, 0);
      expect(total).toBeLessThanOrEqual(24_000);
    }
  });
});
