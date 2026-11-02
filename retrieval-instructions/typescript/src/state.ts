/**
 * sample-state.json: the instructions this sample created and each tenant's release configuration.
 *
 * Both the Python and the TypeScript programs read and write this file, so its format is fixed:
 * schema version 1, `JSON.stringify(obj, null, 2)` plus a newline (the same bytes as Python's
 * `json.dumps(obj, indent=2, ensure_ascii=False)`), written atomically. It holds instruction IDs
 * and ARNs and the account ID, never credentials. It is gitignored.
 */

import * as fs from 'node:fs';
import { UsageError } from './errors';
import { STATE_FILE } from './paths';
import { type ReleaseConfig, VERSION_RE } from './release';
import { KEY_RE, instructionName, specOrder } from './specs';

export const SCHEMA_VERSION = 1;
export const WRITERS = ['python', 'typescript'];
export const WRITER = 'typescript';
const ACCOUNT_RE = /^[0-9]{12}$/;
const ID_RE = /^[a-z0-9]{10}$/;
const ARN_RE =
  /^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:[0-9]{12}:retrieval-instruction\/([a-z0-9]{10})$/;

export interface InstructionEntry {
  name: string;
  id: string;
  arn: string;
  versions: string[];
  createdBy: string;
}

export interface State {
  account: string;
  region: string;
  instructions: Record<string, InstructionEntry>;
  release: Record<string, ReleaseConfig>;
  updatedBy: string;
}

export function newState(account: string, region: string): State {
  return { account, region, instructions: {}, release: {}, updatedBy: WRITER };
}

export function latest(entry: InstructionEntry): string | null {
  return entry.versions.at(-1) ?? null;
}

function invalid(problem: string): UsageError {
  return new UsageError(
    `sample-state.json isn't a valid state file (${problem}). It holds no secrets: fix or delete ` +
      'it; teardown still finds sample instructions by name and tag',
  );
}

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactly(raw: Raw, keys: readonly string[]): boolean {
  const own = Object.keys(raw);
  return own.length === keys.length && keys.every((k) => k in raw);
}

function versionList(value: unknown, key: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((v) => typeof v === 'string' && VERSION_RE.test(v))
  ) {
    throw invalid(`${key}: versions must be a list of version strings`);
  }
  const numbers = (value as string[]).map(Number);
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (numbers.length !== sorted.length || numbers.some((n, i) => n !== sorted[i])) {
    throw invalid(`${key}: versions must be unique and ascending`);
  }
  return [...(value as string[])];
}

function entry(key: string, raw: unknown): InstructionEntry {
  const fields = ['arn', 'createdBy', 'id', 'name', 'versions'];
  if (!isObject(raw) || !hasExactly(raw, fields)) {
    throw invalid(`${key}: an instruction has exactly ${fields.join(', ')}`);
  }
  if (raw.name !== instructionName(key))
    throw invalid(`${key}: name must be ${instructionName(key)}`);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    throw invalid(`${key}: id must be 10 lowercase letters or digits`);
  }
  const match = typeof raw.arn === 'string' ? ARN_RE.exec(raw.arn) : null;
  if (!match || match[1] !== raw.id)
    throw invalid(`${key}: arn must be the instruction's ARN`);
  if (typeof raw.createdBy !== 'string' || !WRITERS.includes(raw.createdBy)) {
    throw invalid(`${key}: createdBy must be python or typescript`);
  }
  return {
    name: raw.name,
    id: raw.id,
    arn: raw.arn as string,
    versions: versionList(raw.versions, key),
    createdBy: raw.createdBy,
  };
}

function release(
  key: string,
  raw: unknown,
  recorded: InstructionEntry | undefined,
): ReleaseConfig {
  if (recorded === undefined)
    throw invalid(`release ${key}: no instruction recorded for this key`);
  if (
    !isObject(raw) ||
    !('live' in raw) ||
    !Object.keys(raw).every((k) => k === 'live' || k === 'canary')
  ) {
    throw invalid(`release ${key}: expected live and an optional canary`);
  }
  const live = raw.live;
  if (typeof live !== 'string' || !recorded.versions.includes(live)) {
    throw invalid(`release ${key}: live must be one of the recorded versions`);
  }
  if (!('canary' in raw)) return { live };
  const canary = raw.canary;
  if (!isObject(canary) || !hasExactly(canary, ['version', 'every'])) {
    throw invalid(`release ${key}: canary has exactly version and every`);
  }
  if (
    typeof canary.version !== 'string' ||
    !recorded.versions.includes(canary.version)
  ) {
    throw invalid(
      `release ${key}: canary version must be one of the recorded versions`,
    );
  }
  const every = canary.every;
  if (typeof every !== 'number' || !Number.isInteger(every) || every < 1) {
    throw invalid(`release ${key}: canary every must be an integer of 1 or more`);
  }
  return { live, canary: { version: canary.version, every } };
}

/** Validate a decoded state file. Throws UsageError (exit 2) for anything outside schema version 1. */
export function parse(raw: unknown): State {
  const top = [
    'account',
    'instructions',
    'region',
    'release',
    'schemaVersion',
    'updatedBy',
  ];
  if (!isObject(raw) || !hasExactly(raw, top))
    throw invalid(`expected exactly ${top.join(', ')}`);
  if (raw.schemaVersion !== SCHEMA_VERSION) throw invalid('schemaVersion must be 1');
  if (typeof raw.account !== 'string' || !ACCOUNT_RE.test(raw.account)) {
    throw invalid('account must be 12 digits');
  }
  if (typeof raw.region !== 'string' || !raw.region) {
    throw invalid('region must be a non-empty string');
  }
  if (typeof raw.updatedBy !== 'string' || !WRITERS.includes(raw.updatedBy)) {
    throw invalid('updatedBy must be python or typescript');
  }
  if (!isObject(raw.instructions) || !isObject(raw.release)) {
    throw invalid('instructions and release must be objects');
  }
  const instructions: Record<string, InstructionEntry> = {};
  for (const [key, value] of Object.entries(raw.instructions)) {
    if (!KEY_RE.test(key)) throw invalid(`instruction key '${key}' isn't a spec key`);
    instructions[key] = entry(key, value);
  }
  const releases: Record<string, ReleaseConfig> = {};
  for (const [key, value] of Object.entries(raw.release)) {
    releases[key] = release(key, value, instructions[key]);
  }
  return {
    account: raw.account,
    region: raw.region,
    instructions,
    release: releases,
    updatedBy: raw.updatedBy,
  };
}

export function toJson(state: State): Raw {
  const releases: Raw = {};
  for (const [key, cfg] of Object.entries(state.release)) {
    releases[key] =
      cfg.canary === undefined
        ? { live: cfg.live }
        : {
            live: cfg.live,
            canary: { version: cfg.canary.version, every: cfg.canary.every },
          };
  }
  const instructions: Raw = {};
  for (const [key, e] of Object.entries(state.instructions)) {
    instructions[key] = {
      name: e.name,
      id: e.id,
      arn: e.arn,
      versions: [...e.versions],
      createdBy: e.createdBy,
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    account: state.account,
    region: state.region,
    instructions,
    release: releases,
    updatedBy: state.updatedBy,
  };
}

export function dumps(state: State): string {
  return JSON.stringify(toJson(state), null, 2) + '\n';
}

/** The state file, or null when it doesn't exist. */
export function load(file: string = STATE_FILE): State | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalid(err instanceof Error ? err.message : String(err));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid('not JSON');
  }
  return parse(raw);
}

/** Write the state atomically: a .tmp file in the same directory, then a rename over the target. */
export function save(state: State, file: string = STATE_FILE): void {
  state.updatedBy = WRITER;
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, dumps(state), 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

export function remove(file: string = STATE_FILE): void {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** Refuse to use instruction IDs recorded for another account or Region. */
export function checkEnvironment(state: State, account: string, region: string): void {
  if (state.account !== account || state.region !== region) {
    throw new UsageError(
      `sample-state.json was written for account ${state.account} in ${state.region}, but the ` +
        `current credentials and Region are account ${account} in ${region}. Switch credentials ` +
        'or set AWS_REGION, or run teardown where the state was written',
    );
  }
}

function ordered<T>(entries: Record<string, T>): Record<string, T> {
  const order = new Map(specOrder().map((key, i) => [key, i]));
  const rank = (key: string): number => order.get(key) ?? order.size;
  const keys = Object.keys(entries).sort((a, b) => rank(a) - rank(b));
  return Object.fromEntries(keys.map((key) => [key, entries[key] as T]));
}

/** Record an instruction, keeping the keys in spec-file order. */
export function putInstruction(
  state: State,
  key: string,
  value: InstructionEntry,
): void {
  state.instructions = ordered({ ...state.instructions, [key]: value });
}

export function addVersion(state: State, key: string, version: string): void {
  const recorded = state.instructions[key];
  if (recorded === undefined)
    throw new RangeError(`no instruction recorded for ${key}`);
  if (!recorded.versions.includes(version)) {
    recorded.versions = [...recorded.versions, version].sort(
      (a, b) => Number(a) - Number(b),
    );
  }
}

export function setRelease(state: State, key: string, cfg: ReleaseConfig): void {
  state.release = ordered({ ...state.release, [key]: cfg });
}

/** Drop an instruction and its release entry together, so the file stays valid. */
export function removeInstruction(state: State, key: string): void {
  delete state.instructions[key];
  delete state.release[key];
}
