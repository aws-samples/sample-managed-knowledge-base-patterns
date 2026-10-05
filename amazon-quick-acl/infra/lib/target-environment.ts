/**
 * Amazon Quick can only consume a Bedrock managed knowledge base when both live in the
 * same Region, and the integration is limited to these four Regions.
 * See https://docs.aws.amazon.com/quick/latest/userguide/byo-bedrock-kb-limitations.html
 */
export const QUICK_SUPPORTED_REGIONS = [
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'ap-southeast-2',
] as const;

export interface TargetEnvironment {
  readonly account: string;
  readonly region: string;
}

/**
 * Resolve the target environment.
 *
 * KB_TARGET_ACCOUNT / KB_TARGET_REGION take precedence, then the CDK_DEFAULT_* values
 * the CDK CLI derives from your AWS profile.
 *
 * The dedicated variables exist because CDK_DEFAULT_REGION cannot be overridden from a
 * .env file: the CDK CLI *replaces* it in the app subprocess with the Region resolved
 * from your AWS configuration (falling back to us-east-1 when none is configured).
 * Setting CDK_DEFAULT_REGION in .env therefore has no effect, which would silently
 * deploy the knowledge base to the wrong Region and leave Amazon Quick unable to see it.
 */
export function resolveTargetEnvironment(env: NodeJS.ProcessEnv): TargetEnvironment {
  const account = env.KB_TARGET_ACCOUNT || env.CDK_DEFAULT_ACCOUNT;
  const region = env.KB_TARGET_REGION || env.CDK_DEFAULT_REGION;

  if (!account || !region) {
    throw new Error(
      'Unable to resolve the target account and Region.\n' +
        'Either configure an AWS profile, or set KB_TARGET_ACCOUNT and KB_TARGET_REGION\n' +
        'in infra/.env. See infra/.env.example.',
    );
  }

  if (!(QUICK_SUPPORTED_REGIONS as readonly string[]).includes(region)) {
    throw new Error(
      `Region "${region}" cannot be used with the Amazon Quick knowledge base integration.\n` +
        `Supported Regions: ${QUICK_SUPPORTED_REGIONS.join(', ')}.\n` +
        'The managed knowledge base and your Amazon Quick instance must be in the same Region.\n' +
        'Set KB_TARGET_REGION in infra/.env to one of the Regions above and re-run.',
    );
  }

  return { account, region };
}
