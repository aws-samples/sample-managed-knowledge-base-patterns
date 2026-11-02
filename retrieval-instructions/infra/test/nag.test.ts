import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { resolveSampleOptions } from '../lib/config';
import { STACK_NAME } from '../lib/names';
import { RetrievalInstructionsSampleStack } from '../lib/sample-stack';
import { EXAMPLE_ACCOUNT, EXAMPLE_PRINCIPAL, EXAMPLE_REGION, newApp } from './support';

/**
 * Proves that cdk-nag is wired and blocks synth. cdk-nag v3 is a validation plugin, so
 * a finding that isn't acknowledged surfaces as a synth failure. Without the failing
 * cases, the passing ones would also pass if the plugin weren't running.
 */
function synthWithNag(
  context: Record<string, unknown>,
  change?: (app: cdk.App, stack: RetrievalInstructionsSampleStack) => void,
): () => void {
  const app = newApp(context);
  const stack = new RetrievalInstructionsSampleStack(app, STACK_NAME, {
    env: { account: EXAMPLE_ACCOUNT, region: EXAMPLE_REGION },
    options: resolveSampleOptions(app.node, { account: EXAMPLE_ACCOUNT }),
  });
  change?.(app, stack);
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return () => {
    app.synth({ force: true });
  };
}

describe('cdk-nag', () => {
  it('passes with the defaults', () => {
    expect(synthWithNag({})).not.toThrow();
  });

  it('passes with tenant roles for one tenant', () => {
    expect(synthWithNag({ trustedPrincipalArn: EXAMPLE_PRINCIPAL })).not.toThrow();
  });

  it("passes with two tenants' roles and the South knowledge base off", () => {
    expect(
      synthWithNag({
        trustedPrincipalArn: EXAMPLE_PRINCIPAL,
        tenantRoles: 'sales-region-north,sales-region-south',
        southKnowledgeBase: false,
      }),
    ).not.toThrow();
  });

  it('fails for a deliberately non-compliant bucket', () => {
    const synth = synthWithNag({}, (app) => {
      const stack = new cdk.Stack(app, 'DeliberatelyNonCompliant', {
        env: { account: EXAMPLE_ACCOUNT, region: EXAMPLE_REGION },
      });
      // No SSL enforcement and no server access logging.
      new s3.Bucket(stack, 'BadBucket');
    });
    expect(synth).toThrow();
  });

  it('fails when the applier gains another wildcard action', () => {
    const synth = synthWithNag(
      { trustedPrincipalArn: EXAMPLE_PRINCIPAL },
      (_app, stack) => {
        const applier = stack.tenantRoles.get('sales-region-north')!.applier;
        applier.addToPolicy(
          new iam.PolicyStatement({
            actions: ['bedrock:Get*'],
            resources: [
              stack.formatArn({
                service: 'bedrock',
                resource: 'retrieval-instruction',
                resourceName: '*',
              }),
            ],
          }),
        );
      },
    );
    expect(synth).toThrow();
  });
});
