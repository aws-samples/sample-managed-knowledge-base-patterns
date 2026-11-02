import { Node } from 'constructs';
import { TENANT_KEYS, TenantKey } from './names';

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_REGION = 'us-east-1';

const ROLE_ARN_LOOKUP =
  'Look up your role ARN with `aws sts get-caller-identity`, then ' +
  '`aws iam get-role --role-name <role-name> --query Role.Arn --output text`.';

const PRINCIPAL_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):(role|user)\/[\w+=,.@/-]{1,512}$/;

/**
 * The Region the stack deploys to: AWS_REGION when it is set (even to an empty string),
 * otherwise us-east-1. The same rule as both SDK programs, so the stack and the
 * commands use one Region. CDK_DEFAULT_REGION, AWS_DEFAULT_REGION, and the profile
 * Region are never read. CDK and the SDKs reject a bad value themselves.
 */
export function resolveRegion(env: Env): string {
  const region = env.AWS_REGION;
  return region === undefined ? DEFAULT_REGION : region;
}

/**
 * The account the stack deploys to: the `account` context value when given, otherwise
 * the account of the credentials, which the CDK CLI passes as CDK_DEFAULT_ACCOUNT.
 */
export function resolveAccount(contextAccount: unknown, env: Env): string {
  if (contextAccount !== undefined) {
    const account = String(contextAccount);
    if (!/^\d{12}$/.test(account)) {
      throw new Error(
        `Invalid account context value "${account}": use 12 digits, for example -c account=123456789012.`,
      );
    }
    return account;
  }
  const account = env.CDK_DEFAULT_ACCOUNT;
  if (!account) {
    throw new Error(
      'No AWS account: configure credentials, or pass -c account=123456789012 to synthesize without them.',
    );
  }
  return account;
}

export interface SampleOptions {
  /** Principal that the tenant and platform admin roles trust. Absent: no such roles. */
  readonly trustedPrincipalArn?: string;
  /** Tenants that get an applier and a tenant admin role. Empty without a principal. */
  readonly tenantRoles: readonly TenantKey[];
  /** Whether to create the Sales Region South knowledge base. */
  readonly southKnowledgeBase: boolean;
}

/** Parse and validate the context options (README: Configuration). */
export function resolveSampleOptions(
  node: Node,
  env: { account: string },
): SampleOptions {
  const southKnowledgeBase = parseBoolean(
    'southKnowledgeBase',
    node.tryGetContext('southKnowledgeBase'),
  );
  const principal: unknown = node.tryGetContext('trustedPrincipalArn');
  if (principal === undefined) {
    return { tenantRoles: [], southKnowledgeBase };
  }
  const trustedPrincipalArn = String(principal);
  const match = PRINCIPAL_ARN.exec(trustedPrincipalArn);
  if (!match) {
    throw new Error(
      `trustedPrincipalArn "${trustedPrincipalArn}" is not an IAM role or user ARN. ` +
        ROLE_ARN_LOOKUP,
    );
  }
  if (match[1] !== env.account) {
    throw new Error(
      `trustedPrincipalArn is in account ${match[1]}, but the stack deploys to account ` +
        `${env.account}. Use a role or user in the deployment account. ${ROLE_ARN_LOOKUP}`,
    );
  }
  const tenantRoles = parseTenantRoles(node.tryGetContext('tenantRoles'));
  return { trustedPrincipalArn, tenantRoles, southKnowledgeBase };
}

function parseBoolean(key: string, value: unknown): boolean {
  if (value === undefined || value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw new Error(`${key} must be true or false. Got "${String(value)}".`);
}

function parseTenantRoles(value: unknown): TenantKey[] {
  const valid = `Valid tenant keys: ${TENANT_KEYS.join(', ')}.`;
  const keys = String(value ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key !== '');
  if (keys.length === 0) {
    throw new Error(`tenantRoles must list at least one tenant key. ${valid}`);
  }
  const unknown = keys.filter(
    (key) => !(TENANT_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `tenantRoles has unknown tenant keys: ${unknown.join(', ')}. ${valid}`,
    );
  }
  return [...new Set(keys)] as TenantKey[];
}
