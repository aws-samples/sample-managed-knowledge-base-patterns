/**
 * Text formatters for every command. Both languages produce the same bytes (test-fixtures/expected/).
 *
 * Values are filled in from the command's results; answers print verbatim. Tables use output.table().
 */

import { type Check, passed } from './abac';
import type { StreamResult } from './ask';
import type { CallRow } from './cloudtrail';
import { UNKNOWN, classify, outside as isOutside } from './corpus';
import { STACK_NAME } from './deployment';
import { type Filter, describeFilter } from './filters';
import type { Candidate } from './instructions';
import {
  dumpsCompact,
  plural,
  pyJsonDumps,
  pyStr,
  table,
  versionsText,
} from './output';
import { type ReleaseConfig, canaryText, describeRelease, versionFor } from './release';
import type { State } from './state';
import { ANSWER_KEYS, validateReply } from './structured-json';

export function appliedText(applied: StreamResult['applied']): string {
  if (!applied || Object.keys(applied).length === 0) return 'none';
  return `${pyStr(applied.id)} version ${applied.version === undefined ? 'unknown' : pyStr(applied.version)}`;
}

function message(tenantLine: string | null, question: string): string[] {
  const text = tenantLine ? `${tenantLine}\n${question}` : question;
  return ['Message:', ...text.split('\n').map((line) => `  ${line}`)];
}

export interface AnswerView {
  tenant: string | null;
  instruction: string | null;
  version: string | null;
  requestIndex: number | null;
  trace: boolean;
  tenantLine: string | null;
  tenantFilter: Filter | null;
  question: string;
  result: StreamResult;
}

/** ask and baseline (baseline passes instruction: null). */
export function formatAnswer(v: AnswerView): string {
  let label =
    v.instruction === null
      ? 'none'
      : `${v.instruction} version ${v.version || 'DRAFT'}`;
  if (v.instruction !== null && v.requestIndex !== null) {
    label += ` (routed by the release configuration, request ${v.requestIndex})`;
  }
  const lines = [
    `Tenant: ${v.tenant || 'none'}`,
    `Instruction: ${label}`,
    `Applied: ${appliedText(v.result.applied)}`,
  ];
  if (v.trace) {
    const planning = v.result.planning;
    lines.push(
      'Planning trace event:',
      '  ' + (planning ? dumpsCompact(planning) : 'none'),
    );
  }
  lines.push(
    `Filter: ${describeFilter(v.tenantFilter)}`,
    ...message(v.tenantLine, v.question),
    'Answer:',
  );
  lines.push(v.result.answer !== null ? v.result.answer : '(no answer)');
  return lines.join('\n') + '\n';
}

function label(retriever: string | null, labels: ReadonlyMap<string, string>): string {
  return labels.get(retriever || '') ?? (retriever || UNKNOWN);
}

/** Rows of [step or retriever, document, scope, entitled], then outside and total by the 8.5 counting rule. */
export function documentRows(
  result: StreamResult,
  tenant: string,
  region: string | null,
  byRetriever: ReadonlyMap<string, string> | null = null,
): [string[][], number, number] {
  const rows: string[][] = [];
  const seen = new Set<string>();
  const known = new Set<string>();
  const outsideKeys = new Set<string>();
  let unknownRows = 0;
  for (const doc of result.documents) {
    const group = byRetriever === null ? doc.step : label(doc.retriever, byRetriever);
    const c = classify(doc.key, tenant, region);
    const ident = JSON.stringify([group, c.document !== UNKNOWN ? doc.key : null]);
    if (seen.has(ident)) continue;
    seen.add(ident);
    rows.push([group, c.document, c.scope, c.entitled]);
    if (c.document === UNKNOWN) {
      unknownRows += 1;
    } else if (doc.key !== null) {
      known.add(doc.key);
      if (isOutside(c)) outsideKeys.add(doc.key);
    }
  }
  return [rows, outsideKeys.size + unknownRows, known.size + unknownRows];
}

function documents(
  rows: string[][],
  header: string[],
  outside: number,
  total: number,
): string[] {
  const lines = rows.length ? table([header, ...rows]) : ['  no documents'];
  const noun = total === 1 ? 'document' : 'documents';
  return [
    ...lines,
    `  Outside the tenant's entitlement: ${outside} of ${total} ${noun}`,
  ];
}

export interface IsolationView {
  tenant: string;
  region: string | null;
  question: string;
  unfiltered: StreamResult;
  filtered: StreamResult;
}

/** The isolation report and whether the filtered request stayed inside the entitlement. */
export function formatIsolation(v: IsolationView): [string, boolean] {
  const header = ['step', 'document', 'scope', 'entitled'];
  const lines = [
    `Tenant: ${v.tenant}`,
    `Question: ${v.question}`,
    '',
    'Without the tenant filter:',
  ];
  let [rows, outside, total] = documentRows(v.unfiltered, v.tenant, v.region);
  lines.push(...documents(rows, header, outside, total));
  if (outside === 0) {
    lines.push(
      '  This call retrieved nothing outside the entitlement; the filter is what guarantees it.',
    );
  }
  lines.push('', 'With the tenant filter:');
  [rows, outside, total] = documentRows(v.filtered, v.tenant, v.region);
  lines.push(...documents(rows, header, outside, total));
  if (outside === 0) {
    lines.push(
      'Result: PASS (the filtered request retrieved only documents the tenant is entitled to)',
    );
  } else {
    lines.push(
      `Result: FAIL (the filtered request retrieved ${plural(outside, 'document')} the tenant ` +
        "isn't entitled to or that couldn't be identified)",
    );
  }
  return [lines.join('\n') + '\n', outside === 0];
}

export interface MultiKbView {
  instruction: string;
  version: string | null;
  sharedId: string;
  southId: string;
  sharedFilter: Filter | null;
  southFilter: Filter | null;
  tenantLine: string;
  question: string;
  result: StreamResult;
}

/** The multi-kb report and how many documents fall outside the entitlement. */
export function formatMultiKb(v: MultiKbView): [string, number] {
  const described = (f: Filter | null): string =>
    f !== null ? describeFilter(f) : 'none (--no-filters)';
  const lines = [
    'Tenant: sales-region-south',
    `Instruction: ${v.instruction} version ${v.version || 'DRAFT'}`,
    `Applied: ${appliedText(v.result.applied)}`,
    'Retrievers:',
    ...table([
      ['retriever', 'knowledge base', 'filter'],
      ['shared', v.sharedId, described(v.sharedFilter)],
      ['south', v.southId, described(v.southFilter)],
    ]),
    ...message(v.tenantLine, v.question),
    'Answer:',
    v.result.answer !== null ? v.result.answer : '(no answer)',
    '',
    'Documents:',
  ];
  const labels = new Map([
    [v.sharedId, 'shared'],
    [v.southId, 'south'],
  ]);
  const [rows, outside, total] = documentRows(
    v.result,
    'sales-region-south',
    null,
    labels,
  );
  lines.push(
    ...documents(rows, ['retriever', 'document', 'scope', 'entitled'], outside, total),
  );
  return [lines.join('\n') + '\n', outside];
}

/** A string as is, a list of strings joined, and any other JSON value as JSON, the same in both languages. */
function value(item: unknown): string {
  if (typeof item === 'string') return item;
  if (Array.isArray(item) && item.every((v) => typeof v === 'string'))
    return item.length ? item.join(', ') : 'none';
  return pyJsonDumps(item, false);
}

export interface StructuredJsonView {
  instruction: string;
  version: string | null;
  tenantFilter: Filter;
  question: string;
  result: StreamResult;
}

export function formatStructuredJson(v: StructuredJsonView): [string, boolean] {
  const check = validateReply(v.result.answer);
  const lines = [
    `Instruction: ${v.instruction} version ${v.version || 'DRAFT'}`,
    `Applied: ${appliedText(v.result.applied)}`,
    `Filter: ${describeFilter(v.tenantFilter)}`,
    `Question: ${v.question}`,
    'Reply:',
    v.result.answer !== null ? v.result.answer : '(no reply)',
  ];
  if (check.strictValid && check.value !== null) {
    const parsed = check.value;
    lines.push('Validation: PASS (one JSON object with exactly the five keys)');
    lines.push(...ANSWER_KEYS.map((key) => `  ${key}: ${value(parsed[key])}`));
  } else {
    lines.push(`Validation: FAIL (${check.parseClass})`);
    lines.push(...check.errors.map((error) => `  - ${error}`));
  }
  return [lines.join('\n') + '\n', check.strictValid];
}

export interface CanaryView {
  version: string;
  every: number;
}

function canary(view: CanaryView | null): string {
  return view ? `${view.version} (1 in ${view.every})` : 'none';
}

export interface JobView {
  status: string;
  startedAt: string;
  scanned: number;
  indexed: number;
  failed: number;
}

export interface StatusView {
  region: string;
  stackStatus: string;
  tenantRoles: string[] | null;
  knowledgeBases: {
    label: string;
    knowledgeBaseId: string;
    dataSourceId: string;
    job: JobView | null;
  }[];
  instructionCount: number;
  quota: number;
  instructions: {
    key: string;
    name: string;
    status: string | null;
    latestVersion: string | null;
    live: string | null;
    canary: CanaryView | null;
  }[];
}

export function formatStatus(view: StatusView): string {
  const roles = view.tenantRoles;
  const lines = [
    `Region: ${view.region}`,
    `Stack: ${STACK_NAME} (${view.stackStatus})`,
    `Tenant roles: ${roles && roles.length ? roles.join(', ') : 'none'}`,
    'Knowledge bases:',
  ];
  const rows = [
    [
      'knowledge base',
      'id',
      'data source',
      'latest ingestion',
      'started',
      'scanned',
      'indexed',
      'failed',
    ],
  ];
  for (const kb of view.knowledgeBases) {
    const job = kb.job;
    if (job === null) {
      rows.push([
        kb.label,
        kb.knowledgeBaseId,
        kb.dataSourceId,
        'none',
        '-',
        '-',
        '-',
        '-',
      ]);
    } else {
      rows.push([
        kb.label,
        kb.knowledgeBaseId,
        kb.dataSourceId,
        job.status,
        job.startedAt,
        String(job.scanned),
        String(job.indexed),
        String(job.failed),
      ]);
    }
  }
  lines.push(...table(rows));
  const { instructionCount: count, quota } = view;
  lines.push(
    `Retrieval instructions in this account and Region: ${count} of ${quota} ` +
      `(${Math.max(quota - count, 0)} free)`,
  );
  if (!view.instructions.length) {
    lines.push('Sample instructions: none (run create-instructions)');
  } else {
    lines.push('Sample instructions:');
    const instructionRows = [
      ['key', 'name', 'status', 'latest version', 'live', 'canary'],
    ];
    for (const i of view.instructions) {
      instructionRows.push([
        i.key,
        i.name,
        i.status || 'not found',
        i.latestVersion || '-',
        i.live || 'none',
        canary(i.canary),
      ]);
    }
    lines.push(...table(instructionRows));
  }
  return lines.join('\n') + '\n';
}

export interface CreateView {
  region: string;
  instructionCount: number;
  quota: number;
  needed: number;
  results: {
    key: string;
    name: string;
    id: string;
    result: string;
    versions: string[] | null;
    live: string | null;
  }[];
}

export function formatCreate(view: CreateView): string {
  const { instructionCount: count, quota, results } = view;
  const lines = [
    `Region: ${view.region}`,
    `Retrieval instructions in this account and Region: ${count} of ${quota} before this run, ` +
      `${view.needed} to create`,
  ];
  const rows = [['key', 'name', 'id', 'result', 'versions', 'live']];
  for (const r of results) {
    rows.push([
      r.key,
      r.name,
      r.id,
      r.result,
      versionsText(r.versions),
      r.live || 'none',
    ]);
  }
  if (results.length) lines.push(...table(rows));
  const created = results.filter((r) => r.result === 'created').length;
  lines.push(
    `Retrieval instructions in this account and Region: ${count + created} of ${quota} after this run`,
  );
  return lines.join('\n') + '\n';
}

export interface SupportV2View {
  name: string;
  id: string;
  version: string;
  change: string;
  rows: {
    key: string;
    name: string;
    latestVersion: string | null;
    live: string | null;
    canary: CanaryView | null;
  }[];
}

export function formatSupportV2(view: SupportV2View): string {
  const lines = [
    `Updated ${view.name} (${view.id}) and created version ${view.version}.`,
    `Change: ${view.change}`,
    'Release pins are unchanged:',
  ];
  const rows = [['key', 'name', 'latest version', 'live', 'canary']];
  for (const r of view.rows) {
    rows.push([
      r.key,
      r.name,
      r.latestVersion || '-',
      r.live || 'none',
      canary(r.canary),
    ]);
  }
  lines.push(...table(rows));
  const updated = view.rows.find((r) => r.name === view.name);
  const key = updated?.key ?? '';
  const live = updated?.live || view.version;
  lines.push(
    `To send one request in five to version ${view.version}, run: release set --tenant ${key} ` +
      `--live ${live} --canary ${view.version} --every 5`,
  );
  return lines.join('\n') + '\n';
}

export function formatReleaseShow(state: State | null): string {
  if (state === null || !Object.keys(state.instructions).length) {
    return 'No sample instructions recorded. Run create-instructions first.\n';
  }
  const rows = [['key', 'name', 'versions', 'live', 'canary']];
  for (const [key, entry] of Object.entries(state.instructions)) {
    const cfg = state.release[key];
    rows.push([
      key,
      entry.name,
      versionsText(entry.versions),
      cfg ? cfg.live : 'none',
      canaryText(cfg),
    ]);
  }
  return (
    ['Release configuration in sample-state.json:', ...table(rows)].join('\n') + '\n'
  );
}

export function formatReleaseRoute(
  tenant: string,
  cfg: ReleaseConfig,
  requests: number,
): string {
  const routes = Array.from({ length: requests }, (_, i) => versionFor(cfg, i));
  const versions = [...new Set(routes)].sort((a, b) => Number(a) - Number(b));
  const counts = versions.map((v) => `${v} = ${routes.filter((r) => r === v).length}`);
  const lines = [`Tenant: ${tenant}`, `Release: ${describeRelease(cfg)}`];
  lines.push(
    ...table([['request', 'version'], ...routes.map((v, i) => [String(i), v])]),
  );
  lines.push('Requests per version: ' + counts.join(', '));
  return lines.join('\n') + '\n';
}

export function formatCloudtrail(
  since: number,
  rows: readonly CallRow[],
  streamCount: number,
): string {
  const lines = [
    `GetRetrievalInstruction calls made by Amazon Bedrock in the last ${since} minutes:`,
  ];
  if (rows.length) {
    lines.push(
      ...table([
        ['time', 'tenant', 'version', 'caller role', 'error'],
        ...rows.map((r) => [r.time, r.tenant, r.version, r.role, r.error]),
      ]),
    );
  } else {
    lines.push(
      '  No matching events yet. Event history can take about 5 minutes to show an event; ' +
        'run cloudtrail --wait to poll.',
    );
  }
  let countLine = `AgenticRetrieveStream events in event history for the same window: ${streamCount}`;
  if (streamCount === 0)
    countLine += ' (a data event: only a trail that records data events has it)';
  lines.push(countLine);
  return lines.join('\n') + '\n';
}

export function formatVerifyAbac(
  tenant: string,
  other: string,
  checks: readonly Check[],
): string {
  const rows = [['check', 'role', 'action', 'expected', 'observed', 'result']];
  checks.forEach((c, i) => {
    rows.push([
      String(i + 1),
      c.role,
      c.action,
      c.expected,
      c.observed,
      passed(c) ? 'PASS' : 'FAIL',
    ]);
  });
  const count = checks.filter(passed).length;
  const result = count === checks.length ? 'PASS' : 'FAIL';
  const lines = [`Tenant: ${tenant}`, `Other tenant: ${other}`, ...table(rows)];
  lines.push(`Result: ${result} (${count} of ${checks.length} checks as expected)`);
  return lines.join('\n') + '\n';
}

export function formatTeardownPlan(cands: readonly Candidate[]): string {
  if (!cands.length) return 'No sample instructions found in this Region.\n';
  const rows = [['name', 'id', 'versions', 'action']];
  for (const c of cands) {
    const action = c.action === 'skip' ? `skip (${pyStr(c.reason)})` : c.action;
    rows.push([
      c.name,
      c.id,
      c.action === 'delete' ? versionsText(c.versions) : '-',
      action,
    ]);
  }
  const n = cands.filter((c) => c.action === 'delete').length;
  const lines = ['Teardown plan (nothing is deleted without --yes):', ...table(rows)];
  if (n) {
    lines.push(
      `Run teardown --yes to delete ${plural(n, 'instruction')} and their versions.`,
    );
  } else if (cands.some((c) => c.action === 'already deleted')) {
    lines.push(
      'Nothing to delete. Run teardown --yes to remove the deleted entries from sample-state.json.',
    );
  } else {
    lines.push('Nothing to delete.');
  }
  return lines.join('\n') + '\n';
}

export interface TeardownOutcome {
  name: string;
  result: string; // deleted, already deleted, skipped, or unconfirmed
  versions: string[];
  reason: string | null;
}

export function formatTeardownLine(o: TeardownOutcome): string {
  if (o.result === 'deleted') {
    const detail = o.versions.length
      ? `versions ${o.versions.join(', ')}`
      : 'no versions';
    return `${o.name} deleted (${detail})\n`;
  }
  if (o.result === 'skipped') return `${o.name} skipped (${pyStr(o.reason)})\n`;
  if (o.result === 'unconfirmed') {
    return `${o.name} deletion not confirmed after 60 s; run teardown --yes again\n`;
  }
  return `${o.name} already deleted\n`;
}

export function formatTeardownSummary(
  outcomes: readonly TeardownOutcome[],
  stateRemoved: boolean,
): string {
  const deleted = outcomes.filter((o) => o.result === 'deleted').length;
  let text = `Deleted ${plural(deleted, 'instruction')}.`;
  if (stateRemoved) text += ' Removed sample-state.json.';
  return text + '\n';
}
