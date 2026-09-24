import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AppStack } from '../lib/app-stack';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';

/**
 * Verifies that cdk-nag is wired and actually blocks a build, rather than merely
 * being imported.
 *
 * A guardrail that runs but never fires is indistinguishable from one that is not
 * running at all. The first test feeds the plugin a deliberately non-compliant
 * bucket and asserts synthesis fails; the rest assert the real stacks synthesize
 * clean. Without the first, the others would also pass if the plugin were not
 * running.
 *
 * cdk-nag v3 registers as an `IPolicyValidationPlugin`, so violations surface as a
 * synth-time failure and in `policy-validation-report.json` — not as CDK
 * annotations. Asserting on synthesis is therefore the correct check.
 */
function synthWithNag(build: (app: cdk.App) => void): () => void {
  const app = new cdk.App();
  build(app);
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return () => {
    app.synth({ force: true });
  };
}

const env = { account: '123456789012', region: 'us-east-1' };

describe('cdk-nag', () => {
  it('fails synthesis for a non-compliant resource', () => {
    const synth = synthWithNag((app) => {
      const stack = new cdk.Stack(app, 'DeliberatelyNonCompliant', { env });
      // No SSL enforcement and no server access logging.
      new s3.Bucket(stack, 'BadBucket');
    });

    expect(synth).toThrow();
  });

  it('passes synthesis for the application stack', () => {
    const synth = synthWithNag((app) => {
      new AppStack(app, 'UnifiedSearch-test-App', {
        stageName: 'test',
        knowledgeBaseId: 'ABCDE12345',
        env,
      });
    });

    expect(synth).not.toThrow();
  });

  /**
   * The knowledge base stack carries one acknowledged finding: the irreducible
   * object-level wildcard on the crawler's read policy. Its finding ID embeds the
   * content bucket's generated logical ID, so renaming that construct invalidates
   * the acknowledgment.
   *
   * This test is what makes that drift visible in CI rather than on a first deploy.
   */
  it('passes synthesis for the knowledge base stack, with its one acknowledged finding', () => {
    const synth = synthWithNag((app) => {
      new KnowledgeBaseStack(app, 'UnifiedSearch-test-KnowledgeBase', {
        stageName: 'test',
        env,
      });
    });

    expect(synth).not.toThrow();
  });

  it('still fails if the acknowledgment no longer matches the finding', () => {
    // Simulates the drift above: an acknowledgment whose ID does not match any
    // finding leaves the finding unsuppressed, and synth must fail.
    const synth = synthWithNag((app) => {
      const stack = new cdk.Stack(app, 'MismatchedAcknowledgment', { env });
      const bucket = new s3.Bucket(stack, 'Logs', {
        enforceSSL: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
      });
      cdk.Validations.of(bucket).acknowledge({
        id: 'AwsSolutions-S1[Resource::does-not-exist]',
        reason:
          'Deliberately mismatched, to prove a stale acknowledgment does not pass.',
      });
    });

    expect(synth).toThrow();
  });
});
