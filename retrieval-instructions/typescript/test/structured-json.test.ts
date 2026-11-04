import { describe, expect, it } from 'vitest';
import { validateReply } from '../src/structured-json';

const VALID = {
  answer: 'You can return an opened unit within 30 days.',
  sources: ['global-returns-policy-v2-0.md'],
  confidence: 'high',
  followUpQuestion: null,
  outOfScope: false,
};
const dumps = (value: unknown): string => JSON.stringify(value);

describe('structured JSON validator', () => {
  it('accepts a valid object as strict', () => {
    const check = validateReply(dumps(VALID));
    expect([
      check.parseClass,
      check.strictValid,
      check.lenientValid,
      check.errors,
    ]).toEqual(['strict', true, true, []]);
    expect(check.value).toEqual(VALID);
  });

  it('fails extra and missing keys', () => {
    expect(validateReply(dumps({ ...VALID, notes: 'x' })).errors).toEqual([
      'extra key notes',
    ]);
    const { outOfScope: _, ...missing } = VALID;
    const check = validateReply(dumps(missing));
    expect(check.strictValid).toBe(false);
    expect(check.errors).toEqual(['missing key outOfScope']);
    expect(check.value).toBeNull();
  });

  it('reads a fenced reply but does not count it as strict', () => {
    const check = validateReply('```json\n' + dumps(VALID) + '\n```');
    expect([check.parseClass, check.strictValid, check.lenientValid]).toEqual([
      'fenced',
      false,
      true,
    ]);
    expect(check.errors).toEqual(['wrapped in a markdown code fence']);
  });

  it.each<[string | null, string]>([
    ['The return window is 30 days.', 'unparseable'],
    ['Here you go: ' + dumps(VALID), 'prose-wrapped'],
    ['   ', 'empty'],
    [null, 'empty'],
  ])('fails a non-JSON reply %j as %s', (reply, parseClass) => {
    const check = validateReply(reply);
    expect(check.parseClass).toBe(parseClass);
    expect(check.strictValid || check.lenientValid).toBe(false);
    expect(check.value).toBeNull();
  });

  // The answerFormat doesn't say what the values look like, so they aren't checked.
  it.each<Record<string, unknown>>([
    { answer: '' },
    { sources: [{ file: 'a.md' }, 1] },
    { confidence: 0.9 },
    { followUpQuestion: false },
    { outOfScope: 'no' },
  ])('accepts any value %j', (patch) => {
    const check = validateReply(dumps({ ...VALID, ...patch }));
    expect([check.strictValid, check.errors, check.value]).toEqual([
      true,
      [],
      { ...VALID, ...patch },
    ]);
  });

  it('fails a top-level array', () => {
    expect(validateReply(dumps([VALID])).errors).toEqual([
      'top level is array, expected object',
    ]);
  });
});
