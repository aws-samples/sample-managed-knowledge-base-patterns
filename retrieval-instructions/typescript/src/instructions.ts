/**
 * Create, version, update, and delete the sample's retrieval instructions.
 *
 * Every update, tag, or delete of an existing instruction first passes the sample instruction
 * guard: the name is one of the 11 names derived from the spec files, and the instruction carries
 * app=retrieval-instructions-sample.
 */

import {
  type BedrockAgentClient,
  CreateRetrievalInstructionCommand,
  CreateRetrievalInstructionVersionCommand,
  DeleteRetrievalInstructionCommand,
  GetRetrievalInstructionCommand,
  type GetRetrievalInstructionResponse,
  ListRetrievalInstructionVersionsCommand,
  type ListRetrievalInstructionVersionsCommandInput,
  ListRetrievalInstructionsCommand,
  type ListRetrievalInstructionsCommandInput,
  ListTagsForResourceCommand,
  type RetrievalInstructionSummary,
  UpdateRetrievalInstructionCommand,
} from '@aws-sdk/client-bedrock-agent';
import { CheckFailed, UsageError, awsError, errorCode, isServiceError } from './errors';
import { progress } from './output';
import {
  type Clock,
  type Review,
  type Sleep,
  type Wait,
  inProgress,
  monotonic,
  reasons,
  sleep as defaultSleep,
  waitForReview,
} from './poll';
import {
  SAMPLE_APP,
  SAMPLE_TAG_KEY,
  type Spec,
  instructionName,
  knownNames,
} from './specs';
import {
  type State,
  WRITER,
  addVersion,
  latest,
  putInstruction,
  removeInstruction,
  setRelease,
} from './state';

const NOT_FOUND = 'ResourceNotFoundException';
const DELETE_CONFIRM_TIMEOUT_S = 60;
const nameExists = (name: string): string =>
  `an instruction named ${name} already exists in this Region. If an earlier run of this sample ` +
  'created it, run teardown --yes and then create-instructions again; otherwise delete or rename it';
const QUOTA_HINT =
  'run teardown --yes to remove what this run created, or raise the retrieval instruction quota';

export type Save = (state: State) => void;

/** Every retrieval instruction summary in the account and Region (ListRetrievalInstructions, paginated). */
export async function listInstructions(
  agent: BedrockAgentClient,
): Promise<RetrievalInstructionSummary[]> {
  const summaries: RetrievalInstructionSummary[] = [];
  const input: ListRetrievalInstructionsCommandInput = { maxResults: 50 };
  for (;;) {
    const page = await agent.send(new ListRetrievalInstructionsCommand({ ...input }));
    summaries.push(...(page.retrievalInstructionSummaries ?? []));
    if (!page.nextToken) return summaries;
    input.nextToken = page.nextToken;
  }
}

/** Numbered versions, ascending. */
export async function listVersions(
  agent: BedrockAgentClient,
  instructionId: string,
): Promise<string[]> {
  const versions: string[] = [];
  const input: ListRetrievalInstructionVersionsCommandInput = {
    retrievalInstructionId: instructionId,
  };
  for (;;) {
    const page = await agent.send(
      new ListRetrievalInstructionVersionsCommand({ ...input }),
    );
    versions.push(
      ...(page.retrievalInstructionVersionSummaries ?? []).map((v) =>
        String(v.version),
      ),
    );
    if (!page.nextToken) {
      return [...new Set(versions.filter((v) => /^[0-9]+$/.test(v)))].sort(
        (a, b) => Number(a) - Number(b),
      );
    }
    input.nextToken = page.nextToken;
  }
}

/** null when the instruction is a sample instruction, else why it isn't. */
export async function guardReason(
  agent: BedrockAgentClient,
  name: string,
  arn: string,
): Promise<string | null> {
  if (!knownNames().includes(name))
    return `${name} isn't one of this sample's instruction names`;
  const tags =
    (await agent.send(new ListTagsForResourceCommand({ resourceArn: arn }))).tags ?? {};
  if (tags[SAMPLE_TAG_KEY] !== SAMPLE_APP)
    return `not tagged ${SAMPLE_TAG_KEY}=${SAMPLE_APP}`;
  return null;
}

export async function requireSample(
  agent: BedrockAgentClient,
  name: string,
  arn: string,
): Promise<void> {
  const reason = await guardReason(agent, name, arn);
  if (reason) throw new UsageError(`refusing to change ${name}: ${reason}`);
}

/** Exit 1 with each reason unless the review ended ACTIVE with `success`. */
export function checkReview(review: Review, name: string, success: string): void {
  if (review.timedOut) {
    throw new CheckFailed(
      `${name}: review still running after 600 s; run the command again later`,
    );
  }
  const { status, lastTransitionStatus } = review.final;
  if (status !== 'ACTIVE' || lastTransitionStatus !== success) {
    const lines = [
      `${name}: review ended ${status} (${lastTransitionStatus})`,
      ...reasons(review.final),
    ];
    throw new CheckFailed(lines.join('\n  '));
  }
}

/** Create the instruction, wait for the review, and create the version to pin. Returns the version. */
export async function createAndPin(
  agent: BedrockAgentClient,
  tenant: string,
  instruction: Readonly<Record<string, string>>,
  description: string,
  record: (instructionId: string, arn: string) => void,
  wait: Wait = waitForReview,
): Promise<string> {
  const created = await agent.send(
    new CreateRetrievalInstructionCommand({
      name: instructionName(tenant),
      instruction, // persona, answerFormat, retrievalGuidance, answerPolicy
      description,
      tags: { tenant, app: 'retrieval-instructions-sample' }, // IAM conditions use both tags
    }),
  );
  const instructionId = String(created.retrievalInstructionId);
  record(instructionId, String(created.retrievalInstructionArn)); // recorded at once: it counts toward the quota
  checkReview(
    await wait(agent, instructionId),
    instructionName(tenant),
    'CREATE_SUCCESSFUL',
  );
  const versioned = await agent.send(
    new CreateRetrievalInstructionVersionCommand({
      retrievalInstructionId: instructionId,
    }),
  );
  return String(versioned.version);
}

/** Replace answerFormat, resending every other field and the description, then create a version. */
export async function updateAnswerFormat(
  agent: BedrockAgentClient,
  instructionId: string,
  answerFormat: string,
  wait: Wait = waitForReview,
): Promise<string> {
  const current = await agent.send(
    new GetRetrievalInstructionCommand({ retrievalInstructionId: instructionId }),
  );
  if (!current.description) {
    throw new UsageError(
      `${current.name} has no description; an update must resend it`,
    );
  }
  await agent.send(
    new UpdateRetrievalInstructionCommand({
      retrievalInstructionId: instructionId,
      instruction: { ...current.instruction, answerFormat },
      description: current.description,
    }),
  );
  checkReview(
    await wait(agent, instructionId),
    String(current.name),
    'UPDATE_SUCCESSFUL',
  );
  const versioned = await agent.send(
    new CreateRetrievalInstructionVersionCommand({
      retrievalInstructionId: instructionId,
    }),
  );
  return String(versioned.version);
}

export interface CreateOutcome {
  key: string;
  name: string;
  id: string;
  result: string; // created, already created, recovered, versions recorded, or version created
  versions: string[];
  live: string | null;
}

function pinLive(state: State, key: string): void {
  const entry = state.instructions[key];
  const newest = entry ? latest(entry) : null;
  if (!(key in state.release) && newest) setRelease(state, key, { live: newest });
}

function outcome(state: State, key: string, result: string): CreateOutcome {
  const entry = state.instructions[key];
  if (entry === undefined) throw new RangeError(`no instruction recorded for ${key}`);
  const cfg = state.release[key];
  return {
    key,
    name: entry.name,
    id: entry.id,
    result,
    versions: [...entry.versions],
    live: cfg ? cfg.live : null,
  };
}

/** The name check and the quota guard, both before anything is created. Returns the number to create. */
export function quotaCheck(
  listed: readonly RetrievalInstructionSummary[],
  state: State,
  specs: readonly Spec[],
  quota: number,
): number {
  const recorded = new Map(
    Object.entries(state.instructions).map(([key, e]) => [key, e.id]),
  );
  const ids = new Set(listed.map((s) => s.retrievalInstructionId));
  const names = new Set(listed.map((s) => s.name));
  for (const spec of specs) {
    if (names.has(spec.name) && !recorded.has(spec.key))
      throw new UsageError(nameExists(spec.name));
  }
  const needed = specs.filter((spec) => !ids.has(recorded.get(spec.key))).length;
  if (listed.length + needed > quota) {
    throw new UsageError(
      `${listed.length} of ${quota} retrieval instructions are in use in this Region and this run ` +
        `needs ${needed} more; free ${listed.length + needed - quota} or pass --quota if your quota ` +
        'is higher',
    );
  }
  return needed;
}

/** Steps for a key already in the state file. null when the instruction is gone and must be created. */
async function existing(
  agent: BedrockAgentClient,
  state: State,
  spec: Spec,
  save: Save,
  wait: Wait,
): Promise<CreateOutcome | null> {
  const entry = state.instructions[spec.key];
  if (entry === undefined) return null;
  let got: GetRetrievalInstructionResponse;
  try {
    got = await agent.send(
      new GetRetrievalInstructionCommand({ retrievalInstructionId: entry.id }),
    );
  } catch (err) {
    if (!isServiceError(err)) throw err;
    if (errorCode(err) !== NOT_FOUND) throw awsError(err);
    removeInstruction(state, spec.key);
    save(state);
    return null;
  }
  await requireSample(agent, String(got.name), entry.arn);
  if (inProgress(got)) {
    const review = await wait(agent, entry.id, { first: got });
    if (review.timedOut) {
      throw new CheckFailed(
        `${spec.name}: review still running after 600 s; run the command again later`,
      );
    }
    got = review.final;
  }
  const { status, lastTransitionStatus: transition } = got;
  if (status === 'ACTIVE' && entry.versions.length) {
    progress(`${spec.name} already created`);
    return outcome(state, spec.key, 'already created');
  }
  if (status === 'ACTIVE') {
    let found = await listVersions(agent, entry.id);
    let result = 'versions recorded';
    if (!found.length) {
      const versioned = await agent.send(
        new CreateRetrievalInstructionVersionCommand({
          retrievalInstructionId: entry.id,
        }),
      );
      found = [String(versioned.version)];
      result = 'version created';
    }
    for (const version of found) addVersion(state, spec.key, version);
    pinLive(state, spec.key);
    save(state);
    return outcome(state, spec.key, result);
  }
  if (
    status === 'INACTIVE' &&
    (transition === 'CREATE_FAILED' || transition === 'UPDATE_FAILED')
  ) {
    progress(`${spec.name}: review had failed; updating it with the current spec`);
    await agent.send(
      new UpdateRetrievalInstructionCommand({
        retrievalInstructionId: entry.id,
        instruction: spec.instruction,
        description: spec.description,
      }),
    );
    checkReview(await wait(agent, entry.id), spec.name, 'UPDATE_SUCCESSFUL');
    const versioned = await agent.send(
      new CreateRetrievalInstructionVersionCommand({
        retrievalInstructionId: entry.id,
      }),
    );
    addVersion(state, spec.key, String(versioned.version));
    pinLive(state, spec.key);
    save(state);
    return outcome(state, spec.key, 'recovered');
  }
  throw new CheckFailed(
    `${spec.name} is ${status} (${transition}); check it with status`,
  );
}

/** The per-key algorithm, after `quotaCheck`. Appends to `outcomes` as it goes; stops at the first failure. */
export async function createInstructions(
  agent: BedrockAgentClient,
  state: State,
  specs: readonly Spec[],
  outcomes: CreateOutcome[],
  save: Save,
  createdBy: string = WRITER,
  wait: Wait = waitForReview,
): Promise<void> {
  for (const spec of specs) {
    if (spec.key in state.instructions) {
      const done = await existing(agent, state, spec, save, wait);
      if (done !== null) {
        outcomes.push(done);
        continue;
      }
    }
    const record = (instructionId: string, arn: string): void => {
      putInstruction(state, spec.key, {
        name: spec.name,
        id: instructionId,
        arn,
        versions: [],
        createdBy,
      });
      save(state);
    };
    progress(`creating ${spec.name}`);
    let version: string;
    try {
      version = await createAndPin(
        agent,
        spec.key,
        spec.instruction,
        spec.description,
        record,
        wait,
      );
    } catch (err) {
      if (!isServiceError(err)) throw err;
      const code = errorCode(err);
      if (code === 'ConflictException') throw awsError(err, nameExists(spec.name));
      if (code === 'ServiceQuotaExceededException') throw awsError(err, QUOTA_HINT);
      throw awsError(err);
    }
    addVersion(state, spec.key, version);
    pinLive(state, spec.key);
    save(state);
    outcomes.push(outcome(state, spec.key, 'created'));
  }
}

/** Update one tenant's answerFormat, record the new version, and leave every release pin as it is. */
export async function supportV2(
  agent: BedrockAgentClient,
  state: State,
  key: string,
  answerFormat: string,
  save: Save,
  wait: Wait = waitForReview,
): Promise<string> {
  const entry = state.instructions[key];
  if (entry === undefined || !entry.versions.length) {
    throw new UsageError(
      `no instruction for ${key} in sample-state.json; run create-instructions first`,
    );
  }
  let version: string;
  try {
    const got = await agent.send(
      new GetRetrievalInstructionCommand({ retrievalInstructionId: entry.id }),
    );
    await requireSample(agent, String(got.name), entry.arn);
    version = await updateAnswerFormat(agent, entry.id, answerFormat, wait);
  } catch (err) {
    if (!isServiceError(err)) throw err;
    throw awsError(err);
  }
  addVersion(state, key, version);
  save(state);
  return version;
}

export interface Candidate {
  key: string | null; // state-file key, or null for an instruction found only by name
  name: string;
  id: string;
  arn: string;
  versions: string[] | null; // newest first; null when unknown
  action: string; // delete, already deleted, or skip
  reason: string | null; // why it is skipped
  review: GetRetrievalInstructionResponse | null; // the GetRetrievalInstruction response
}

export function candidate(
  key: string | null,
  name: string,
  id: string,
  arn: string,
  fields: Partial<Candidate> = {},
): Candidate {
  return {
    key,
    name,
    id,
    arn,
    versions: null,
    action: 'delete',
    reason: null,
    review: null,
    ...fields,
  };
}

/** State-file entries, then listed instructions with a sample name that the state file doesn't hold. */
export async function candidates(
  agent: BedrockAgentClient,
  state: State | null,
): Promise<Candidate[]> {
  const found = Object.entries(state?.instructions ?? {}).map(([key, e]) =>
    candidate(key, e.name, e.id, e.arn),
  );
  const recorded = new Set(found.map((c) => c.id));
  const names = knownNames();
  for (const summary of await listInstructions(agent)) {
    const id = String(summary.retrievalInstructionId);
    if (names.includes(String(summary.name)) && !recorded.has(id)) {
      found.push(
        candidate(
          null,
          String(summary.name),
          id,
          String(summary.retrievalInstructionArn),
        ),
      );
    }
  }
  return found;
}

/** Fill in versions and the action. A missing recorded instruction is `already deleted`. */
export async function inspect(
  agent: BedrockAgentClient,
  cand: Candidate,
): Promise<Candidate> {
  try {
    cand.review = await agent.send(
      new GetRetrievalInstructionCommand({ retrievalInstructionId: cand.id }),
    );
    const reason = await guardReason(agent, cand.name, cand.arn);
    if (reason) {
      cand.action = 'skip';
      cand.reason = reason;
      return cand;
    }
    cand.versions = (await listVersions(agent, cand.id)).reverse();
  } catch (err) {
    if (!isServiceError(err)) throw err;
    if (errorCode(err) === NOT_FOUND) {
      cand.action = 'already deleted';
      return cand;
    }
    throw awsError(err);
  }
  cand.action = 'delete';
  return cand;
}

export interface DeleteOptions {
  wait?: Wait;
  sleep?: Sleep;
  clock?: Clock;
}

/**
 * Delete versions newest first, then the instruction, and confirm it is gone.
 *
 * Returns `deleted`, `already deleted`, or `unconfirmed`.
 */
export async function deleteInstruction(
  agent: BedrockAgentClient,
  cand: Candidate,
  options: DeleteOptions = {},
): Promise<string> {
  const wait = options.wait ?? waitForReview;
  const pause = options.sleep ?? defaultSleep;
  const clock = options.clock ?? monotonic;
  try {
    if (cand.review && inProgress(cand.review))
      await wait(agent, cand.id, { first: cand.review });
    for (const version of cand.versions ?? []) {
      await agent.send(
        new DeleteRetrievalInstructionCommand({
          retrievalInstructionId: cand.id,
          retrievalInstructionVersion: version,
        }),
      );
    }
    await agent.send(
      new DeleteRetrievalInstructionCommand({ retrievalInstructionId: cand.id }),
    );
  } catch (err) {
    if (!isServiceError(err)) throw err;
    if (errorCode(err) === NOT_FOUND) return 'already deleted';
    throw awsError(err);
  }
  const start = clock();
  while (clock() - start < DELETE_CONFIRM_TIMEOUT_S) {
    try {
      await agent.send(
        new GetRetrievalInstructionCommand({ retrievalInstructionId: cand.id }),
      );
    } catch (err) {
      if (!isServiceError(err)) throw err;
      if (errorCode(err) === NOT_FOUND) return 'deleted';
      throw awsError(err);
    }
    await pause(2);
  }
  return 'unconfirmed';
}
