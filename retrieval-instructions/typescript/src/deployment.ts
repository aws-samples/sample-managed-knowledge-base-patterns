/** The deployed stack: its status and outputs, read with DescribeStacks every time (never cached). */

import {
  type CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { UsageError, awsError, isServiceError } from './errors';

export const STACK_NAME = 'RetrievalInstructionsSample';
export const OUTPUT_KEYS = {
  sharedKnowledgeBaseId: 'SharedKnowledgeBaseId',
  sharedKnowledgeBaseArn: 'SharedKnowledgeBaseArn',
  sharedDataSourceId: 'SharedDataSourceId',
  southKnowledgeBaseId: 'SouthKnowledgeBaseId',
  southKnowledgeBaseArn: 'SouthKnowledgeBaseArn',
  southDataSourceId: 'SouthDataSourceId',
  corpusBucketName: 'CorpusBucketName',
  tenantRoleTenants: 'TenantRoleTenants',
  platformAdminRoleArn: 'PlatformAdminRoleArn',
};
export const TENANT_OUTPUT_PREFIXES = {
  applierRoleArn: 'ApplierRoleArn',
  tenantAdminRoleArn: 'TenantAdminRoleArn',
};
const REQUIRED_OUTPUTS = [
  'SharedKnowledgeBaseId',
  'SharedDataSourceId',
  'CorpusBucketName',
];
export const NO_ROLES =
  'this stack has no tenant roles; deploy with -c trustedPrincipalArn=<your role ARN> ' +
  '(README: Check the tenant roles)';

/** `sales-region-north` -> `SalesRegionNorth`. */
export function pascal(key: string): string {
  return key
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join('');
}

export function stackMissing(err: unknown): boolean {
  return (
    isServiceError(err) &&
    err.name === 'ValidationError' &&
    err.message.includes('does not exist')
  );
}

export class Deployment {
  constructor(
    readonly status: string,
    readonly outputs: Readonly<Record<string, string>>,
  ) {}

  get sharedKnowledgeBaseId(): string {
    return this.outputs.SharedKnowledgeBaseId ?? '';
  }

  get sharedDataSourceId(): string {
    return this.outputs.SharedDataSourceId ?? '';
  }

  get southKnowledgeBaseId(): string | null {
    return this.outputs.SouthKnowledgeBaseId ?? null;
  }

  get southDataSourceId(): string | null {
    return this.outputs.SouthDataSourceId ?? null;
  }

  get tenantRoleTenants(): string[] {
    return (this.outputs.TenantRoleTenants ?? '').split(',').filter((key) => key);
  }

  roleArn(prefix: string, tenant?: string): string {
    const key = tenant ? prefix + pascal(tenant) : prefix;
    const arn = this.outputs[key];
    if (arn === undefined) throw new UsageError(NO_ROLES);
    return arn;
  }
}

/** Stack status and outputs. Exit 2 when the stack is missing, busy, failed, or missing an output. */
export async function describe(
  cloudformation: CloudFormationClient,
  region: string,
): Promise<Deployment> {
  let stack;
  try {
    const response = await cloudformation.send(
      new DescribeStacksCommand({ StackName: STACK_NAME }),
    );
    stack = response.Stacks?.[0];
  } catch (err) {
    if (stackMissing(err)) {
      throw new UsageError(
        `stack ${STACK_NAME} not found in ${region}; deploy it first, or set AWS_REGION to the ` +
          'Region you deployed to',
      );
    }
    throw awsError(err);
  }
  const status = String(stack?.StackStatus);
  if (status.endsWith('_IN_PROGRESS') || status.endsWith('_FAILED')) {
    throw new UsageError(
      `stack ${STACK_NAME} is ${status}; wait for it to finish or deploy again`,
    );
  }
  const outputs: Record<string, string> = {};
  for (const o of stack?.Outputs ?? [])
    outputs[String(o.OutputKey)] = String(o.OutputValue);
  for (const key of REQUIRED_OUTPUTS) {
    if (!outputs[key])
      throw new UsageError(`stack outputs are missing ${key}; deploy again`);
  }
  return new Deployment(status, outputs);
}
