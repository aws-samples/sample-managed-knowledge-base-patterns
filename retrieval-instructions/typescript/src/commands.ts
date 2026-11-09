/**
 * One function per command. The text each command prints comes from formats.ts.
 *
 * Every AWS-calling command except teardown runs the preflight first: credentials, the stack and
 * its outputs, and the state file's account and Region. release show, set, and route read only the
 * state file.
 */

import {
  BedrockAgentClient,
  GetRetrievalInstructionCommand,
  type IngestionJobSummary,
  ListIngestionJobsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import {
  type CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import type { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { GetCallerIdentityCommand, type STSClient } from '@aws-sdk/client-sts';
import { type ClientFactory, defaultOther, passed, verifyAbac } from './abac';
import { type StreamResult, askAsTenant, buildRequest, sendRequest } from './ask';
import { Lookup, lookup } from './cloudtrail';
import * as config from './config';
import { type Deployment, STACK_NAME, describe, stackMissing } from './deployment';
import {
  AwsError,
  SampleError,
  UsageError,
  awsError,
  errorCode,
  isServiceError,
} from './errors';
import { REGIONS } from './filters';
import {
  type JobView,
  type StatusView,
  type TeardownOutcome,
  appliedText,
  formatAnswer,
  formatCloudtrail,
  formatCreate,
  formatIsolation,
  formatMultiKb,
  formatReleaseRoute,
  formatReleaseShow,
  formatStatus,
  formatStructuredJson,
  formatSupportV2,
  formatTeardownLine,
  formatTeardownPlan,
  formatTeardownSummary,
  formatVerifyAbac,
} from './formats';
import {
  type CreateOutcome,
  candidates,
  createInstructions,
  deleteInstruction,
  inspect,
  listInstructions,
  quotaCheck,
  supportV2,
} from './instructions';
import { out, progress, utc } from './output';
import { STATE_FILE } from './paths';
import { type Clock, type Sleep, monotonic, sleep } from './poll';
import {
  type Canary,
  type ReleaseConfig,
  VERSION_RE,
  checkedRelease,
  describeRelease,
  versionFor,
} from './release';
import {
  STRUCTURED_JSON_KEY,
  combinedSpecs,
  defaultSpecs,
  instructionName,
  supportV2 as supportV2Spec,
  tenantSpecs,
} from './specs';
import * as stateFile from './state';
import type { State } from './state';
import {
  type TenantFilter,
  southRetrieverFilters,
  tenantRequest,
  tenantScope,
} from './tenancy';

const INGESTION_RUNNING = ['STARTING', 'IN_PROGRESS', 'STOPPING'];
const INGESTION_POLL_S = 10;
const INGESTION_TIMEOUT_S = 1800;
const CLOUDTRAIL_POLL_S = 60;
const CLOUDTRAIL_TIMEOUT_S = 900;
const NO_CREDENTIALS = 'no valid AWS credentials; configure a profile or sign in';
const NO_ANSWER = 'error: the response has no answer';

/** The AWS clients and the side effects a command uses, so tests can replace them. */
export interface Context {
  agent: BedrockAgentClient;
  runtime: BedrockAgentRuntimeClient;
  sts: STSClient;
  cloudformation: CloudFormationClient;
  cloudtrail: CloudTrailClient;
  region: string;
  clientFactory: ClientFactory;
  statePath: string;
  sleep: Sleep;
  clock: Clock;
  now: () => Date;
}

/** Clients from config.ts: AWS_REGION, else us-east-1. */
export function defaultContext(): Promise<Context> {
  return Promise.resolve({
    agent: config.agent,
    runtime: config.runtime,
    sts: config.sts,
    cloudformation: config.cloudformation,
    cloudtrail: config.cloudtrail,
    region: config.region,
    clientFactory: {
      runtime: (credentials) =>
        new BedrockAgentRuntimeClient({
          region: config.region,
          credentials,
          ...config.RUNTIME_CONFIG,
        }),
      agent: (credentials) =>
        new BedrockAgentClient({ region: config.region, credentials }),
    },
    statePath: STATE_FILE,
    sleep,
    clock: monotonic,
    now: () => new Date(),
  });
}

// ---------------------------------------------------------------------------------------------
// Preflight and input validation

export interface Preflight {
  account: string;
  deployment: Deployment;
  state: State | null;
}

export async function callerAccount(ctx: Context): Promise<string> {
  try {
    const identity = await ctx.sts.send(new GetCallerIdentityCommand({}));
    return String(identity.Account);
  } catch (err) {
    if (
      isServiceError(err) ||
      (err instanceof Error && err.name === 'CredentialsProviderError')
    ) {
      throw new SampleError(NO_CREDENTIALS);
    }
    throw err;
  }
}

export function loadState(ctx: Context, account: string): State | null {
  const loaded = stateFile.load(ctx.statePath);
  if (loaded !== null) stateFile.checkEnvironment(loaded, account, ctx.region);
  return loaded;
}

export async function preflight(ctx: Context): Promise<Preflight> {
  const account = await callerAccount(ctx);
  const deployment = await describe(ctx.cloudformation, ctx.region);
  return { account, deployment, state: loadState(ctx, account) };
}

export function checkQuestion(question: string): string {
  const text = question.trim();
  if (!text || text.length > 1000)
    throw new UsageError('--question must be 1 to 1,000 characters');
  return text;
}

export function checkVersion(version: string | null): void {
  if (version !== null && version !== 'DRAFT' && !VERSION_RE.test(version)) {
    throw new UsageError('--version must be DRAFT or a version number such as 1 or 2');
  }
}

export function checkRange(
  name: string,
  value: number | null,
  low: number,
  high?: number,
): void {
  if (value === null) return;
  if (value < low || (high !== undefined && value > high)) {
    throw new UsageError(
      high === undefined
        ? `${name} must be ${low} or more`
        : `${name} must be ${low} to ${high}`,
    );
  }
}

/** ask, baseline, and isolation: a tenant key, or a combined key already in the state file. */
export function checkAskTenant(tenant: string, state: State | null): void {
  const tenants = tenantSpecs().map((spec) => spec.key);
  const combined = combinedSpecs().map((spec) => spec.key);
  if (combined.includes(tenant)) {
    if (state === null || !(tenant in state.instructions)) {
      throw new UsageError(
        `${tenant} isn't in sample-state.json; run create-instructions --combined first`,
      );
    }
    return;
  }
  if (!tenants.includes(tenant)) {
    throw new UsageError(
      `--tenant must be one of ${tenants.join(', ')}, or a combined key: ${combined.join(', ')}`,
    );
  }
}

export function releaseConfig(state: State | null, tenant: string): ReleaseConfig {
  const cfg = state?.release[tenant];
  if (cfg === undefined) {
    const hint = tenant.includes('.')
      ? 'run create-instructions --combined first'
      : 'run create-instructions first';
    throw new UsageError(`no instruction for ${tenant} in sample-state.json; ${hint}`);
  }
  return cfg;
}

function streamFailed(result: StreamResult): void {
  if (result.error !== null)
    throw new AwsError(result.error.code, result.error.message);
}

async function send(fn: () => Promise<StreamResult>): Promise<StreamResult> {
  try {
    return await fn();
  } catch (err) {
    if (!isServiceError(err)) throw err;
    const hint =
      errorCode(err) === 'ValidationException' ? 'check release show' : undefined;
    throw awsError(err, hint);
  }
}

function releaseView(cfg: ReleaseConfig | undefined): [string | null, Canary | null] {
  if (cfg === undefined) return [null, null];
  return [
    cfg.live,
    cfg.canary ? { version: cfg.canary.version, every: cfg.canary.every } : null,
  ];
}

// ---------------------------------------------------------------------------------------------
// Commands

function jobView(job: IngestionJobSummary | null): JobView | null {
  if (job === null) return null;
  const stats = job.statistics ?? {};
  const started = job.startedAt;
  const indexed =
    (stats.numberOfNewDocumentsIndexed ?? 0) +
    (stats.numberOfModifiedDocumentsIndexed ?? 0);
  return {
    status: String(job.status),
    startedAt: started instanceof Date ? utc(started) : String(started ?? '-'),
    scanned: stats.numberOfDocumentsScanned ?? 0,
    indexed,
    failed: stats.numberOfDocumentsFailed ?? 0,
  };
}

function ingestionOk(job: JobView | null): boolean {
  return job !== null && job.status === 'COMPLETE' && job.failed === 0;
}

export async function cmdStatus(
  ctx: Context,
  wait: boolean,
  quota: number,
): Promise<number> {
  checkRange('--quota', quota, 1, 10_000);
  const pre = await preflight(ctx);
  const dep = pre.deployment;
  const kbs: [string, string, string][] = [
    ['shared', dep.sharedKnowledgeBaseId, dep.sharedDataSourceId],
  ];
  if (dep.southKnowledgeBaseId && dep.southDataSourceId) {
    kbs.push(['south', dep.southKnowledgeBaseId, dep.southDataSourceId]);
  }
  const latestJobs = async (): Promise<(IngestionJobSummary | null)[]> => {
    const jobs: (IngestionJobSummary | null)[] = [];
    for (const [, kb, ds] of kbs) {
      const page = await ctx.agent.send(
        new ListIngestionJobsCommand({
          knowledgeBaseId: kb,
          dataSourceId: ds,
          sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
          maxResults: 1,
        }),
      );
      jobs.push(page.ingestionJobSummaries?.[0] ?? null);
    }
    return jobs;
  };
  const rows: StatusView['instructions'] = [];
  let jobs = await latestJobs();
  const start = ctx.clock();
  while (
    wait &&
    jobs.some((j) => j === null || INGESTION_RUNNING.includes(String(j.status)))
  ) {
    if (ctx.clock() - start >= INGESTION_TIMEOUT_S) break;
    const states = jobs.map((j) => (j ? String(j.status) : 'none')).join(', ');
    progress(`waiting for ingestion: ${states}, ${Math.trunc(ctx.clock() - start)} s`);
    await ctx.sleep(INGESTION_POLL_S);
    jobs = await latestJobs();
  }
  const listed = await listInstructions(ctx.agent);
  const current = pre.state;
  for (const [key, entry] of Object.entries(current?.instructions ?? {})) {
    let status: string | null = null;
    let latestVersion: string | null = null;
    try {
      const got = await ctx.agent.send(
        new GetRetrievalInstructionCommand({ retrievalInstructionId: entry.id }),
      );
      status = String(got.status);
      latestVersion = got.latestVersion || stateFile.latest(entry);
    } catch (err) {
      if (errorCode(err) !== 'ResourceNotFoundException') throw err;
    }
    const [live, canary] = releaseView(current?.release[key]);
    rows.push({ key, name: entry.name, status, latestVersion, live, canary });
  }
  const kbViews = kbs.map(([label, kb, ds], i) => ({
    label,
    knowledgeBaseId: kb,
    dataSourceId: ds,
    job: jobView(jobs[i] ?? null),
  }));
  const tenantRoles = dep.tenantRoleTenants;
  out(
    formatStatus({
      region: ctx.region,
      stackStatus: dep.status,
      tenantRoles: tenantRoles.length ? tenantRoles : null,
      knowledgeBases: kbViews,
      instructionCount: listed.length,
      quota,
      instructions: rows,
    }),
  );
  const bad = kbViews.filter((v) => !ingestionOk(v.job)).map((v) => v.label);
  if (bad.length) {
    progress(
      `error: ingestion isn't complete for the ${bad.join(', ')} knowledge base`,
    );
    return 1;
  }
  return 0;
}

export async function cmdCreateInstructions(
  ctx: Context,
  combined: boolean,
  quota: number,
): Promise<number> {
  checkRange('--quota', quota, 1, 10_000);
  const pre = await preflight(ctx);
  const current = pre.state ?? stateFile.newState(pre.account, ctx.region);
  const specs = [...defaultSpecs(), ...(combined ? combinedSpecs() : [])];
  const outcomes: CreateOutcome[] = [];
  const save = (s: State): void => stateFile.save(s, ctx.statePath);
  const listed = await listInstructions(ctx.agent);
  const needed = quotaCheck(listed, current, specs, quota);
  try {
    await createInstructions(ctx.agent, current, specs, outcomes, save);
  } finally {
    out(
      formatCreate({
        region: ctx.region,
        instructionCount: listed.length,
        quota,
        needed,
        results: outcomes.map((o) => ({
          key: o.key,
          name: o.name,
          id: o.id,
          result: o.result,
          versions: o.versions,
          live: o.live,
        })),
      }),
    );
  }
  return 0;
}

export async function cmdBaseline(
  ctx: Context,
  rawQuestion: string,
  tenant: string | null,
  region: string | null,
): Promise<number> {
  const question = checkQuestion(rawQuestion);
  if (tenant === null && region !== null) {
    throw new UsageError('--region works only with a team tenant');
  }
  const pre = await preflight(ctx);
  let line: string | null = null;
  let tenantFilter: TenantFilter | null = null;
  if (tenant !== null) {
    checkAskTenant(tenant, pre.state);
    [line, tenantFilter] = tenantScope(tenant, region);
  }
  const kb = pre.deployment.sharedKnowledgeBaseId;
  const request = buildRequest({
    question,
    retrievers: [[kb, tenantFilter]],
    tenantLine: line,
    instructionId: null,
    version: null,
  });
  const result = await send(() => sendRequest(ctx.runtime, request));
  out(
    formatAnswer({
      tenant,
      instruction: null,
      version: null,
      requestIndex: null,
      trace: false,
      tenantLine: line,
      tenantFilter,
      question,
      result,
    }),
  );
  streamFailed(result);
  if (result.answer === null) {
    progress(NO_ANSWER);
    return 1;
  }
  return 0;
}

export async function cmdAsk(
  ctx: Context,
  tenant: string,
  rawQuestion: string,
  region: string | null,
  requested: string | null,
  requestIndex: number | null,
  trace: boolean,
): Promise<number> {
  const question = checkQuestion(rawQuestion);
  checkVersion(requested);
  checkRange('--request-index', requestIndex, 0);
  if (region !== null && !REGIONS.includes(region)) {
    throw new UsageError(`--region must be one of ${REGIONS.join(', ')}`);
  }
  if (requested !== null && requestIndex !== null) {
    throw new UsageError("--version and --request-index can't be used together");
  }
  const pre = await preflight(ctx);
  checkAskTenant(tenant, pre.state);
  const routed = requested === null && requestIndex !== null;
  let version = requested;
  if (version === null) {
    const cfg = releaseConfig(pre.state, tenant);
    version = requestIndex !== null ? versionFor(cfg, requestIndex) : cfg.live;
  }
  const req = tenantRequest(pre.state, tenant, region, version);
  const kb = pre.deployment.sharedKnowledgeBaseId;
  let result: StreamResult;
  if (req.tenantLine !== null && req.version !== null) {
    result = await send(() => askAsTenant(ctx.runtime, req, kb, question));
  } else {
    const request = buildRequest({
      question,
      retrievers: [[kb, req.tenantFilter]],
      tenantLine: req.tenantLine,
      instructionId: req.instructionId,
      version: req.version,
    });
    result = await send(() => sendRequest(ctx.runtime, request));
  }
  out(
    formatAnswer({
      tenant,
      instruction: instructionName(tenant),
      version,
      requestIndex: routed ? requestIndex : null,
      trace,
      tenantLine: req.tenantLine,
      tenantFilter: req.tenantFilter,
      question,
      result,
    }),
  );
  streamFailed(result);
  if (result.answer === null) {
    progress(NO_ANSWER);
    return 1;
  }
  const applied = result.applied ?? {};
  if (
    applied.id !== req.instructionId ||
    applied.version !== (req.version || 'DRAFT')
  ) {
    progress(
      `error: the applied instruction (${appliedText(result.applied)}) differs from the requested ` +
        `one (${req.instructionId} version ${req.version || 'DRAFT'})`,
    );
    return 1;
  }
  return 0;
}

export async function cmdIsolation(
  ctx: Context,
  tenant: string,
  rawQuestion: string,
  region: string | null,
): Promise<number> {
  const question = checkQuestion(rawQuestion);
  const pre = await preflight(ctx);
  checkAskTenant(tenant, pre.state);
  const req = tenantRequest(
    pre.state,
    tenant,
    region,
    releaseConfig(pre.state, tenant).live,
  );
  const kb = pre.deployment.sharedKnowledgeBaseId;
  const results: StreamResult[] = [];
  for (const tenantFilter of [null, req.tenantFilter]) {
    const request = buildRequest({
      question,
      retrievers: [[kb, tenantFilter]],
      tenantLine: req.tenantLine,
      instructionId: req.instructionId,
      version: req.version,
      generateResponse: false,
    });
    const result = await send(() => sendRequest(ctx.runtime, request));
    streamFailed(result);
    results.push(result);
  }
  const [unfiltered, filtered] = results as [StreamResult, StreamResult];
  const [text, ok] = formatIsolation({
    tenant,
    region,
    question,
    unfiltered,
    filtered,
  });
  out(text);
  return ok ? 0 : 1;
}

export async function cmdStructuredJson(
  ctx: Context,
  rawQuestion: string,
): Promise<number> {
  const question = checkQuestion(rawQuestion);
  const pre = await preflight(ctx);
  const version = releaseConfig(pre.state, STRUCTURED_JSON_KEY).live;
  const req = tenantRequest(pre.state, STRUCTURED_JSON_KEY, null, version);
  const request = buildRequest({
    question,
    retrievers: [[pre.deployment.sharedKnowledgeBaseId, req.tenantFilter]],
    tenantLine: null,
    instructionId: req.instructionId,
    version: req.version,
  });
  const result = await send(() => sendRequest(ctx.runtime, request));
  streamFailed(result);
  const [text, ok] = formatStructuredJson({
    instruction: instructionName(STRUCTURED_JSON_KEY),
    version,
    tenantFilter: req.tenantFilter,
    question,
    result,
  });
  out(text);
  return ok ? 0 : 1;
}

export async function cmdMultiKb(
  ctx: Context,
  rawQuestion: string,
  requested: string | null,
  noFilters: boolean,
): Promise<number> {
  const question = checkQuestion(rawQuestion);
  checkVersion(requested);
  const pre = await preflight(ctx);
  const southId = pre.deployment.southKnowledgeBaseId;
  if (southId === null) {
    throw new UsageError(
      'this stack has no Sales Region South knowledge base; deploy with -c southKnowledgeBase=true',
    );
  }
  const tenant = 'sales-region-south';
  const version = requested || releaseConfig(pre.state, tenant).live;
  const req = tenantRequest(pre.state, tenant, null, version);
  const sharedId = pre.deployment.sharedKnowledgeBaseId;
  const [fShared, fSouth] = noFilters ? [null, null] : southRetrieverFilters();
  const request = buildRequest({
    question,
    retrievers: [
      [sharedId, fShared],
      [southId, fSouth],
    ],
    tenantLine: req.tenantLine,
    instructionId: req.instructionId,
    version: req.version,
  });
  const result = await send(() => sendRequest(ctx.runtime, request));
  streamFailed(result);
  const [text, outside] = formatMultiKb({
    instruction: instructionName(tenant),
    version,
    sharedId,
    southId,
    sharedFilter: fShared,
    southFilter: fSouth,
    tenantLine: req.tenantLine ?? '',
    question,
    result,
  });
  out(text);
  if (result.answer === null) {
    progress(NO_ANSWER);
    return 1;
  }
  if (outside && !noFilters) {
    progress(
      "error: the filtered request retrieved documents outside the tenant's entitlement",
    );
    return 1;
  }
  return 0;
}

export async function cmdSupportV2(ctx: Context): Promise<number> {
  const pre = await preflight(ctx);
  const spec = supportV2Spec();
  const current = pre.state;
  if (current === null) {
    throw new UsageError(
      `no instruction for ${spec.key} in sample-state.json; run create-instructions first`,
    );
  }
  const save = (s: State): void => stateFile.save(s, ctx.statePath);
  const version = await supportV2(
    ctx.agent,
    current,
    spec.key,
    spec.answerFormat,
    save,
  );
  const entry = current.instructions[spec.key];
  if (entry === undefined)
    throw new RangeError(`no instruction recorded for ${spec.key}`);
  const rows = Object.entries(current.instructions).map(([key, e]) => {
    const [live, canary] = releaseView(current.release[key]);
    return { key, name: e.name, latestVersion: stateFile.latest(e), live, canary };
  });
  out(
    formatSupportV2({
      name: entry.name,
      id: entry.id,
      version,
      change: spec.change,
      rows,
    }),
  );
  return 0;
}

function recorded(current: State | null, tenant: string): State {
  if (current === null || !(tenant in current.instructions)) {
    const keys = current ? Object.keys(current.instructions).join(', ') : '';
    throw new UsageError(
      `--tenant must be a key in sample-state.json${keys ? ': ' + keys : ''}`,
    );
  }
  return current;
}

export function cmdReleaseShow(statePath: string): number {
  out(formatReleaseShow(stateFile.load(statePath)));
  return 0;
}

export function cmdReleaseSet(
  statePath: string,
  tenant: string,
  live: string,
  canary: string | null,
  every: number | null,
): number {
  const current = recorded(stateFile.load(statePath), tenant);
  const entry = current.instructions[tenant];
  if (entry === undefined)
    throw new RangeError(`no instruction recorded for ${tenant}`);
  const cfg = checkedRelease(
    entry.name,
    entry.versions,
    live,
    canary ?? undefined,
    every ?? undefined,
  );
  stateFile.setRelease(current, tenant, cfg);
  stateFile.save(current, statePath);
  out(`Release for ${tenant}: ${describeRelease(cfg)}\n`);
  return 0;
}

export function cmdReleaseRoute(
  statePath: string,
  tenant: string,
  requests: number,
): number {
  checkRange('--requests', requests, 1, 1000);
  const current = recorded(stateFile.load(statePath), tenant);
  const cfg = current.release[tenant];
  if (cfg === undefined) {
    throw new UsageError(
      `${tenant} has no release configuration; run release set first`,
    );
  }
  out(formatReleaseRoute(tenant, cfg, requests));
  return 0;
}

export async function cmdCloudtrail(
  ctx: Context,
  since: number,
  wait: boolean,
): Promise<number> {
  checkRange('--since', since, 1, 1440);
  const pre = await preflight(ctx);
  if (pre.state === null || !Object.keys(pre.state.instructions).length) {
    throw new UsageError(
      'no instructions in sample-state.json; run create-instructions first',
    );
  }
  const idToKey = new Map(
    Object.entries(pre.state.instructions).map(([key, e]) => [e.id, key]),
  );
  const client = new Lookup(ctx.cloudtrail, ctx.sleep);
  const start = ctx.clock();
  let [rows, streams] = await lookup(client, idToKey, since, ctx.now());
  while (wait && !rows.length && ctx.clock() - start < CLOUDTRAIL_TIMEOUT_S) {
    progress(
      `waiting for CloudTrail event history: ${Math.trunc(ctx.clock() - start)} s`,
    );
    await ctx.sleep(CLOUDTRAIL_POLL_S);
    [rows, streams] = await lookup(client, idToKey, since, ctx.now());
  }
  out(formatCloudtrail(since, rows, streams));
  if (wait && !rows.length) {
    progress('error: no matching GetRetrievalInstruction event within 15 minutes');
    return 1;
  }
  return 0;
}

export async function cmdVerifyAbac(
  ctx: Context,
  requestedTenant: string | null,
  requestedOther: string | null,
): Promise<number> {
  const pre = await preflight(ctx);
  const roles = pre.deployment.tenantRoleTenants;
  const tenant = requestedTenant || roles[0] || 'sales-region-north';
  const other = requestedOther || defaultOther(tenant);
  if (!REGIONS.includes(other) || other === tenant) {
    throw new UsageError(
      `--other must be a sales region key other than ${tenant}: ${REGIONS.join(', ')}`,
    );
  }
  if (pre.state === null) {
    throw new UsageError(
      'no instructions in sample-state.json; run create-instructions first',
    );
  }
  const checks = await verifyAbac({
    sts: ctx.sts,
    agent: ctx.agent,
    deployment: pre.deployment,
    state: pre.state,
    tenant,
    other,
    clientFactory: ctx.clientFactory,
  });
  out(formatVerifyAbac(tenant, other, checks));
  return checks.every(passed) ? 0 : 1;
}

export async function cmdTeardown(ctx: Context, yes: boolean): Promise<number> {
  const account = await callerAccount(ctx);
  try {
    await ctx.cloudformation.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  } catch (err) {
    if (!isServiceError(err)) throw err;
    if (stackMissing(err)) {
      progress(
        `stack ${STACK_NAME} not found in ${ctx.region}; deleting sample instructions anyway`,
      );
    } else {
      progress(
        `warning: DescribeStacks failed (${errorCode(err)}); continuing without the stack`,
      );
    }
  }
  const current = loadState(ctx, account);
  const cands = [];
  for (const c of await candidates(ctx.agent, current))
    cands.push(await inspect(ctx.agent, c));
  if (!yes) {
    out(formatTeardownPlan(cands));
    return 0;
  }
  const outcomes: TeardownOutcome[] = [];
  for (const cand of cands) {
    let outcome: TeardownOutcome;
    if (cand.action === 'skip') {
      outcome = {
        name: cand.name,
        result: 'skipped',
        versions: [],
        reason: cand.reason,
      };
    } else if (cand.action === 'already deleted') {
      outcome = {
        name: cand.name,
        result: 'already deleted',
        versions: [],
        reason: null,
      };
    } else {
      const result = await deleteInstruction(ctx.agent, cand, {
        sleep: ctx.sleep,
        clock: ctx.clock,
      });
      const versions = result === 'deleted' ? [...(cand.versions ?? [])] : [];
      outcome = { name: cand.name, result, versions, reason: null };
    }
    if (
      current !== null &&
      cand.key !== null &&
      (outcome.result === 'deleted' || outcome.result === 'already deleted')
    ) {
      stateFile.removeInstruction(current, cand.key);
      stateFile.save(current, ctx.statePath);
    }
    outcomes.push(outcome);
    out(formatTeardownLine(outcome));
  }
  let removed = false;
  if (current !== null && !Object.keys(current.instructions).length) {
    stateFile.remove(ctx.statePath);
    removed = true;
  }
  out(formatTeardownSummary(outcomes, removed));
  return outcomes.some((o) => o.result === 'unconfirmed') ? 1 : 0;
}
