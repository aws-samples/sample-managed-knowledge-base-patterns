/** The instruction spec files under instructions/: load, validate, and derive names and tags. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { UsageError } from './errors';
import { INSTRUCTIONS_DIR } from './paths';

export const SAMPLE_APP = 'retrieval-instructions-sample'; // value of the `app` tag on everything the sample creates
export const SAMPLE_TAG_KEY = 'app';
export const TENANT_TAG_KEY = 'tenant';
export const STRUCTURED_JSON_KEY = 'structured-json';
export const FIELDS = ['persona', 'answerFormat', 'retrievalGuidance', 'answerPolicy'];
export const KINDS = ['region', 'team', 'combined', 'json'];
export const KEY_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)?$/;
export const NAME_RE = /^([0-9a-zA-Z][_-]?){1,100}$/;
export const MAX_INSTRUCTION_CHARS = 24_000;

/** `assistant-<key>`, with the dot of a combined key replaced, because names allow no dots. */
export function instructionName(key: string): string {
  return 'assistant-' + key.replaceAll('.', '-');
}

export class Spec {
  constructor(
    readonly key: string,
    readonly kind: string,
    readonly description: string,
    readonly instruction: Readonly<Record<string, string>>,
  ) {}

  get name(): string {
    return instructionName(this.key);
  }

  get tags(): Record<string, string> {
    return { [TENANT_TAG_KEY]: this.key, [SAMPLE_TAG_KEY]: SAMPLE_APP };
  }
}

export interface SupportV2 {
  key: string;
  change: string;
  answerFormat: string;
}

function invalid(file: string, problem: string): UsageError {
  return new UsageError(
    `instructions/${path.basename(file)} is invalid: ${problem}. Restore it from the repository`,
  );
}

function read(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw invalid(file, err instanceof Error ? err.message : String(err));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => k in value);
}

export function validateSpec(raw: unknown, file: string): Spec {
  if (!isObject(raw) || !sameKeys(raw, ['key', 'kind', 'description', 'instruction'])) {
    throw invalid(
      file,
      'each spec has exactly key, kind, description, and instruction',
    );
  }
  const { key, kind, description, instruction } = raw;
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw invalid(file, `key ${JSON.stringify(key)} doesn't match ${KEY_RE.source}`);
  }
  if (!NAME_RE.test(instructionName(key))) {
    throw invalid(
      file,
      `name '${instructionName(key)}' doesn't match the API name pattern`,
    );
  }
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    throw invalid(file, `${key}: kind must be one of ${KINDS.join(', ')}`);
  }
  if (
    typeof description !== 'string' ||
    description.length < 1 ||
    description.length > 200
  ) {
    throw invalid(file, `${key}: description must be 1 to 200 characters`);
  }
  if (
    !isObject(instruction) ||
    Object.keys(instruction).length === 0 ||
    !Object.keys(instruction).every((f) => FIELDS.includes(f))
  ) {
    throw invalid(
      file,
      `${key}: instruction needs at least one of ${FIELDS.join(', ')} and nothing else`,
    );
  }
  const fields: Record<string, string> = {};
  for (const [field, text] of Object.entries(instruction)) {
    if (typeof text !== 'string' || !text.trim())
      throw invalid(file, `${key}: ${field} is empty`);
    fields[field] = text;
  }
  const total = Object.values(fields).reduce((sum, text) => sum + text.length, 0);
  if (total > MAX_INSTRUCTION_CHARS) {
    throw invalid(
      file,
      `${key}: the instruction is over ${MAX_INSTRUCTION_CHARS} characters`,
    );
  }
  return new Spec(key, kind, description, fields);
}

export function loadSpecs(file: string): Spec[] {
  const raw = read(file);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid(file, 'expected a non-empty JSON array of specs');
  }
  const specs = raw.map((item) => validateSpec(item, file));
  const keys = specs.map((spec) => spec.key);
  if (new Set(keys).size !== keys.length) throw invalid(file, 'duplicate keys');
  return specs;
}

function cached<T>(load: () => T): () => T {
  let value: { v: T } | undefined;
  return () => (value ??= { v: load() }).v;
}

export const tenantSpecs = cached(() =>
  loadSpecs(path.join(INSTRUCTIONS_DIR, 'tenants.json')),
);
export const structuredJsonSpecs = cached(() =>
  loadSpecs(path.join(INSTRUCTIONS_DIR, 'structured-json.json')),
);
export const combinedSpecs = cached(() =>
  loadSpecs(path.join(INSTRUCTIONS_DIR, 'combined.json')),
);

/** The six tenants and the structured JSON instruction, in spec-file order. */
export function defaultSpecs(): Spec[] {
  return [...tenantSpecs(), ...structuredJsonSpecs()];
}

/** Every spec in spec-file order: the default set, then the four combined cells. */
export function allSpecs(): Spec[] {
  const specs = [...defaultSpecs(), ...combinedSpecs()];
  const keys = specs.map((spec) => spec.key);
  if (new Set(keys).size !== keys.length) {
    throw invalid(
      path.join(INSTRUCTIONS_DIR, 'combined.json'),
      'a key repeats across spec files',
    );
  }
  return specs;
}

export function specFor(key: string): Spec | undefined {
  return allSpecs().find((spec) => spec.key === key);
}

/** The 11 instruction names this sample can create. Teardown deletes only these. */
export function knownNames(): string[] {
  return allSpecs().map((spec) => spec.name);
}

export function specOrder(): string[] {
  return allSpecs().map((spec) => spec.key);
}

export const supportV2 = cached((): SupportV2 => {
  const file = path.join(INSTRUCTIONS_DIR, 'support-v2.json');
  const raw = read(file);
  if (!isObject(raw) || !sameKeys(raw, ['key', 'change', 'answerFormat'])) {
    throw invalid(file, 'expected an object with key, change, and answerFormat');
  }
  if (!Object.values(raw).every((v) => typeof v === 'string' && v.trim())) {
    throw invalid(file, 'key, change, and answerFormat must be non-empty strings');
  }
  const { key, change, answerFormat } = raw as Record<string, string>;
  return { key: key ?? '', change: change ?? '', answerFormat: answerFormat ?? '' };
});
