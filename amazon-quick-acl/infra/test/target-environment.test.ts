import { describe, expect, it } from 'vitest';
import { resolveTargetEnvironment } from '../lib/target-environment';

describe('resolveTargetEnvironment', () => {
  it('prefers KB_TARGET_* over the values the CDK CLI injects', () => {
    expect(
      resolveTargetEnvironment({
        KB_TARGET_ACCOUNT: '111122223333',
        KB_TARGET_REGION: 'eu-west-1',
        CDK_DEFAULT_ACCOUNT: '123456789012',
        CDK_DEFAULT_REGION: 'us-east-1',
      }),
    ).toEqual({ account: '111122223333', region: 'eu-west-1' });
  });

  it('falls back to CDK_DEFAULT_* when KB_TARGET_* are blank', () => {
    expect(
      resolveTargetEnvironment({
        KB_TARGET_ACCOUNT: '',
        KB_TARGET_REGION: '',
        CDK_DEFAULT_ACCOUNT: '123456789012',
        CDK_DEFAULT_REGION: 'us-west-2',
      }),
    ).toEqual({ account: '123456789012', region: 'us-west-2' });
  });

  it('rejects a Region the Quick integration does not support', () => {
    expect(() =>
      resolveTargetEnvironment({
        KB_TARGET_ACCOUNT: '123456789012',
        KB_TARGET_REGION: 'us-east-2',
      }),
    ).toThrow(/cannot be used with the Amazon Quick/);
  });

  it('fails when neither an account nor a Region can be resolved', () => {
    expect(() => resolveTargetEnvironment({})).toThrow(/Unable to resolve/);
  });
});
