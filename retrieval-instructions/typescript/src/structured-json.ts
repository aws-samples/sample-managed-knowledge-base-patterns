/**
 * Strict validation of the structured JSON reply that instructions/structured-json.json asks for.
 *
 * The reply must be exactly one JSON object with the keys answer, sources, confidence,
 * followUpQuestion, and outOfScope. A reply wrapped in one markdown code fence is reported as
 * `fenced`: readable, but not strict.
 */

import { pyJsonDumps } from './output';

export const ANSWER_KEYS = [
  'answer',
  'sources',
  'confidence',
  'followUpQuestion',
  'outOfScope',
] as const;
export const CONFIDENCE_VALUES = ['high', 'medium', 'low'];
const FENCE = /^\s*```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/;

export interface Validation {
  parseClass: string; // strict, fenced, prose-wrapped, unparseable, or empty
  strictValid: boolean; // the whole reply is the JSON object and every schema rule holds
  lenientValid: boolean; // as strict, but one code fence around the object is tolerated
  errors: string[];
  value: Record<string, unknown> | null; // the parsed object when lenientValid
}

function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

/** Everything wrong with a parsed reply. An empty list means it matches the schema. */
export function schemaErrors(value: unknown): string[] {
  if (kind(value) !== 'object') return [`top level is ${kind(value)}, expected object`];
  const obj = value as Record<string, unknown>;
  const allowed: readonly string[] = ANSWER_KEYS;
  const errors = ANSWER_KEYS.filter((key) => !(key in obj)).map(
    (key) => `missing key ${key}`,
  );
  errors.push(
    ...Object.keys(obj)
      .filter((key) => !allowed.includes(key))
      .map((key) => `extra key ${key}`),
  );
  if ('answer' in obj && !(typeof obj.answer === 'string' && obj.answer.trim())) {
    errors.push('answer must be a non-empty string');
  }
  if ('sources' in obj) {
    if (!Array.isArray(obj.sources)) errors.push('sources must be an array');
    else if (!obj.sources.every((source) => typeof source === 'string')) {
      errors.push('sources must contain only strings');
    }
  }
  if (
    'confidence' in obj &&
    !(typeof obj.confidence === 'string' && CONFIDENCE_VALUES.includes(obj.confidence))
  ) {
    errors.push(
      `confidence ${pyJsonDumps(obj.confidence)} is not one of high, medium, low`,
    );
  }
  if (
    'followUpQuestion' in obj &&
    !(obj.followUpQuestion === null || typeof obj.followUpQuestion === 'string')
  ) {
    errors.push('followUpQuestion must be a string or null');
  }
  if ('outOfScope' in obj && typeof obj.outOfScope !== 'boolean') {
    errors.push('outOfScope must be a boolean');
  }
  return errors;
}

function parse(text: string): [boolean, unknown] {
  try {
    return [true, JSON.parse(text)];
  } catch {
    return [false, null];
  }
}

function validation(
  parseClass: string,
  strictValid: boolean,
  lenientValid: boolean,
  errors: string[],
  value: unknown = null,
): Validation {
  return {
    parseClass,
    strictValid,
    lenientValid,
    errors,
    value: value as Record<string, unknown> | null,
  };
}

/** Classify and check one reply. Never throws. */
export function validateReply(raw: string | null): Validation {
  const text = raw ?? '';
  if (!text.trim()) return validation('empty', false, false, ['empty reply']);
  let [ok, value] = parse(text);
  if (ok) {
    const errors = schemaErrors(value);
    const valid = errors.length === 0;
    return validation('strict', valid, valid, errors, valid ? value : null);
  }
  const fence = FENCE.exec(text);
  if (fence) {
    [ok, value] = parse(fence[1] ?? '');
    if (ok) {
      const errors = schemaErrors(value);
      const valid = errors.length === 0;
      return validation(
        'fenced',
        false,
        valid,
        ['wrapped in a markdown code fence', ...errors],
        valid ? value : null,
      );
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && first < last) {
    [ok, value] = parse(text.slice(first, last + 1));
    if (ok) {
      return validation('prose-wrapped', false, false, [
        'JSON object found inside other text',
        ...schemaErrors(value),
      ]);
    }
  }
  return validation('unparseable', false, false, ['reply is not JSON']);
}
