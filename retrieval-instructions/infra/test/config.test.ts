import { describe, expect, it } from 'vitest';
import { resolveAccount, resolveRegion, resolveSampleOptions } from '../lib/config';
import { EXAMPLE_ACCOUNT, EXAMPLE_PRINCIPAL, OTHER_ACCOUNT, newApp } from './support';

const env = { account: EXAMPLE_ACCOUNT };

function options(context: Record<string, unknown>) {
  return resolveSampleOptions(newApp(context).node, env);
}

describe('resolveRegion', () => {
  it('uses AWS_REGION when it is set', () => {
    expect(resolveRegion({ AWS_REGION: 'eu-west-1' })).toBe('eu-west-1');
  });

  it('defaults to us-east-1', () => {
    expect(resolveRegion({})).toBe('us-east-1');
  });

  it('ignores AWS_DEFAULT_REGION and CDK_DEFAULT_REGION', () => {
    expect(
      resolveRegion({
        AWS_DEFAULT_REGION: 'eu-west-1',
        CDK_DEFAULT_REGION: 'eu-west-1',
      }),
    ).toBe('us-east-1');
  });
});

describe('resolveAccount', () => {
  it('uses the account context value', () => {
    expect(resolveAccount('123456789012', { CDK_DEFAULT_ACCOUNT: OTHER_ACCOUNT })).toBe(
      '123456789012',
    );
  });

  it('falls back to the credentials account', () => {
    expect(resolveAccount(undefined, { CDK_DEFAULT_ACCOUNT: '123456789012' })).toBe(
      '123456789012',
    );
  });

  it('refuses to synthesize without an account', () => {
    expect(() => resolveAccount(undefined, {})).toThrow(
      'No AWS account: configure credentials, or pass -c account=123456789012 to synthesize without them.',
    );
  });

  it('rejects an account context value that is not 12 digits', () => {
    expect(() => resolveAccount('12345', {})).toThrow('Invalid account context value');
  });
});

describe('resolveSampleOptions', () => {
  it('has no tenant roles without trustedPrincipalArn, and the South KB on', () => {
    expect(options({})).toEqual({ tenantRoles: [], southKnowledgeBase: true });
  });

  it('creates roles for sales-region-north by default once a principal is given', () => {
    expect(options({ trustedPrincipalArn: EXAMPLE_PRINCIPAL })).toEqual({
      trustedPrincipalArn: EXAMPLE_PRINCIPAL,
      tenantRoles: ['sales-region-north'],
      southKnowledgeBase: true,
    });
  });

  it('reads a comma-separated tenant list and removes duplicates', () => {
    const resolved = options({
      trustedPrincipalArn: EXAMPLE_PRINCIPAL,
      tenantRoles: 'sales-region-north, team-support,sales-region-north',
    });
    expect(resolved.tenantRoles).toEqual(['sales-region-north', 'team-support']);
  });

  it('accepts southKnowledgeBase as a boolean or a string', () => {
    expect(options({ southKnowledgeBase: 'false' }).southKnowledgeBase).toBe(false);
    expect(options({ southKnowledgeBase: false }).southKnowledgeBase).toBe(false);
    expect(options({ southKnowledgeBase: 'true' }).southKnowledgeBase).toBe(true);
  });

  it('rejects a southKnowledgeBase value that is not a boolean', () => {
    expect(() => options({ southKnowledgeBase: 'yes' })).toThrow(
      'southKnowledgeBase must be true or false',
    );
  });

  it('rejects a malformed trustedPrincipalArn and prints the lookup command', () => {
    expect(() => options({ trustedPrincipalArn: 'ExampleOperatorRole' })).toThrow(
      /is not an IAM role or user ARN\. Look up your role ARN with `aws sts get-caller-identity`/,
    );
  });

  it('rejects a trustedPrincipalArn in another account', () => {
    expect(() =>
      options({
        trustedPrincipalArn: `arn:aws:iam::${OTHER_ACCOUNT}:role/ExampleOperatorRole`,
      }),
    ).toThrow(
      `trustedPrincipalArn is in account ${OTHER_ACCOUNT}, but the stack deploys to account 123456789012`,
    );
  });

  it('rejects an unknown tenantRoles key and lists the valid keys', () => {
    expect(() =>
      options({
        trustedPrincipalArn: EXAMPLE_PRINCIPAL,
        tenantRoles: 'sales-region-west',
      }),
    ).toThrow(
      'tenantRoles has unknown tenant keys: sales-region-west. Valid tenant keys: sales-region-north,',
    );
  });

  it('rejects an empty tenantRoles list', () => {
    expect(() =>
      options({ trustedPrincipalArn: EXAMPLE_PRINCIPAL, tenantRoles: ' , ' }),
    ).toThrow('tenantRoles must list at least one tenant key');
  });
});
