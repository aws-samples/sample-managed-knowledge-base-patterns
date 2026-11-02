/**
 * Check the tenant role tag conditions with five calls. Nothing is created.
 *
 * The role sessions last 900 seconds, and their credentials stay in memory: nothing prints or
 * writes them.
 */

import {
  type BedrockAgentClient,
  GetRetrievalInstructionCommand,
  TagResourceCommand,
} from '@aws-sdk/client-bedrock-agent';
import type { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { AssumeRoleCommand, type STSClient } from '@aws-sdk/client-sts';
import { buildRequest, sendRequest } from './ask';
import { NO_ROLES, TENANT_OUTPUT_PREFIXES, type Deployment } from './deployment';
import { AwsError, UsageError, awsError, errorCode, isServiceError } from './errors';
import { progress } from './output';
import { SAMPLE_APP, SAMPLE_TAG_KEY, TENANT_TAG_KEY } from './specs';
import type { State } from './state';
import { type TenantRequest, tenantRequest } from './tenancy';

export const SESSION_SECONDS = 900;
export const SESSION_NAME = 'retrieval-instructions-verify-abac';
export const CHECK_APP_VALUE = 'verify-abac-check';
const DENIED = 'AccessDeniedException';
const TRUST_HINT =
  "your identity isn't the trusted principal; deploy with -c trustedPrincipalArn=<your role ARN>";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** Builds a client that signs with one role's credentials. */
export interface ClientFactory {
  runtime(credentials: Credentials): BedrockAgentRuntimeClient;
  agent(credentials: Credentials): BedrockAgentClient;
}

export interface Check {
  role: string;
  action: string;
  expected: string; // allow or deny
  observed: string; // allow or deny
}

export function passed(check: Check): boolean {
  return check.expected === check.observed;
}

/** Temporary credentials for one role, kept in memory only. */
export async function assume(sts: STSClient, roleArn: string): Promise<Credentials> {
  let response;
  try {
    response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: SESSION_NAME,
        DurationSeconds: SESSION_SECONDS,
      }),
    );
  } catch (err) {
    if (!isServiceError(err)) throw err;
    if (isDenied(errorCode(err))) throw new UsageError(TRUST_HINT);
    throw awsError(err);
  }
  const c = response.Credentials;
  return {
    accessKeyId: String(c?.AccessKeyId),
    secretAccessKey: String(c?.SecretAccessKey),
    sessionToken: String(c?.SessionToken),
  };
}

function isDenied(code: string): boolean {
  return code === DENIED || code === 'AccessDenied';
}

/** allow or deny for a planning-only request that applies the request's instruction. */
async function apply(
  runtime: BedrockAgentRuntimeClient,
  req: TenantRequest,
  knowledgeBaseId: string,
): Promise<string> {
  const request = buildRequest({
    question: 'What is the return window?',
    retrievers: [[knowledgeBaseId, req.tenantFilter]],
    tenantLine: req.tenantLine,
    instructionId: req.instructionId,
    version: req.version,
    generateResponse: false,
  });
  let result;
  try {
    result = await sendRequest(runtime, request);
  } catch (err) {
    if (!isServiceError(err)) throw err;
    if (isDenied(errorCode(err))) return 'deny';
    throw awsError(err);
  }
  if (result.error === null) return 'allow';
  if (isDenied(result.error.code)) return 'deny';
  throw new AwsError(result.error.code, result.error.message);
}

async function call(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (!isServiceError(err)) throw err;
    if (isDenied(errorCode(err))) return 'deny';
    throw awsError(err);
  }
  return 'allow';
}

/** Put a tag back with the reader's own credentials after an unexpected allow. */
async function restore(
  agent: BedrockAgentClient,
  arn: string,
  tags: Record<string, string>,
): Promise<void> {
  const pairs = Object.entries(tags).map(([k, v]) => `${k}=${v}`);
  try {
    await agent.send(new TagResourceCommand({ resourceArn: arn, tags }));
    progress(`restored the tag ${pairs.join(', ')}`);
  } catch (err) {
    if (!isServiceError(err)) throw err;
    progress(
      `could not restore the tag; run: aws bedrock-agent tag-resource --resource-arn ${arn} ` +
        `--tags ${pairs.join(' ')}`,
    );
  }
}

export interface VerifyOptions {
  sts: STSClient;
  agent: BedrockAgentClient;
  deployment: Deployment;
  state: State;
  tenant: string;
  other: string;
  clientFactory: ClientFactory;
}

/** Run the five checks in order and return them with what was observed. */
export async function verifyAbac(options: VerifyOptions): Promise<Check[]> {
  const { sts, agent, deployment, state, tenant, other, clientFactory } = options;
  if (!deployment.tenantRoleTenants.length) throw new UsageError(NO_ROLES);
  if (!deployment.tenantRoleTenants.includes(tenant)) {
    throw new UsageError(
      `${tenant} has no tenant roles in this stack; deploy with -c trustedPrincipalArn=<your role ` +
        'ARN> -c tenantRoles=<tenants>',
    );
  }
  for (const key of [tenant, other]) {
    if (!(key in state.instructions) || !(key in state.release)) {
      throw new UsageError(
        `no instruction for ${key} in sample-state.json; run create-instructions first`,
      );
    }
  }
  const own = state.instructions[tenant];
  const theirs = state.instructions[other];
  const ownLive = state.release[tenant]?.live;
  const theirLive = state.release[other]?.live;
  if (!own || !theirs || !ownLive || !theirLive)
    throw new RangeError('state checked above');
  const req = tenantRequest(state, tenant, null, ownLive);
  const otherReq: TenantRequest = {
    ...req,
    instructionId: theirs.id,
    version: theirLive,
  };
  const applier = clientFactory.runtime(
    await assume(
      sts,
      deployment.roleArn(TENANT_OUTPUT_PREFIXES.applierRoleArn, tenant),
    ),
  );
  const tenantAdmin = clientFactory.agent(
    await assume(
      sts,
      deployment.roleArn(TENANT_OUTPUT_PREFIXES.tenantAdminRoleArn, tenant),
    ),
  );
  const platformAdmin = clientFactory.agent(
    await assume(sts, deployment.roleArn('PlatformAdminRoleArn')),
  );
  const kb = deployment.sharedKnowledgeBaseId;
  const checks: Check[] = [
    {
      role: 'applier',
      action: `apply ${own.name}`,
      expected: 'allow',
      observed: await apply(applier, req, kb),
    },
  ];
  checks.push({
    role: 'applier',
    action: `apply ${theirs.name}`,
    expected: 'deny',
    observed: await apply(applier, otherReq, kb),
  });
  const retag = { [TENANT_TAG_KEY]: tenant };
  let observed = await call(() =>
    tenantAdmin.send(new TagResourceCommand({ resourceArn: theirs.arn, tags: retag })),
  );
  checks.push({
    role: 'tenant admin',
    action: `tag ${theirs.name} with ${TENANT_TAG_KEY}=${tenant}`,
    expected: 'deny',
    observed,
  });
  if (observed === 'allow')
    await restore(agent, theirs.arn, { [TENANT_TAG_KEY]: other });
  const appTags = { [TENANT_TAG_KEY]: tenant, [SAMPLE_TAG_KEY]: CHECK_APP_VALUE };
  observed = await call(() =>
    tenantAdmin.send(new TagResourceCommand({ resourceArn: own.arn, tags: appTags })),
  );
  checks.push({
    role: 'tenant admin',
    action: `tag ${own.name} with ${SAMPLE_TAG_KEY}=${CHECK_APP_VALUE}`,
    expected: 'deny',
    observed,
  });
  if (observed === 'allow')
    await restore(agent, own.arn, { [SAMPLE_TAG_KEY]: SAMPLE_APP });
  observed = await call(() =>
    platformAdmin.send(
      new GetRetrievalInstructionCommand({ retrievalInstructionId: theirs.id }),
    ),
  );
  checks.push({
    role: 'platform admin',
    action: `read ${theirs.name}`,
    expected: 'allow',
    observed,
  });
  return checks;
}

export function defaultOther(tenant: string): string {
  return tenant === 'sales-region-central'
    ? 'sales-region-north'
    : 'sales-region-central';
}
