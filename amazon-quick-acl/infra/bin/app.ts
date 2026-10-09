#!/usr/bin/env node
import { config } from 'dotenv';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ManagedKbStack } from '../lib/managed-kb-stack';
import { resolveTargetEnvironment } from '../lib/target-environment';

config({ quiet: true });

const env = resolveTargetEnvironment(process.env);

const app = new cdk.App();

const stack = new ManagedKbStack(app, 'ManagedKbStack', {
  env,
  description:
    'Amazon Bedrock Managed Knowledge Base wired for use as an Amazon Quick knowledge source',
  kbName: process.env.KB_NAME || 'quick-managed-kb',
  aclEnabled: process.env.KB_S3_ACL_ENABLED !== 'false',
});

/**
 * Accepted cdk-nag findings.
 *
 * cdk-nag v3 dropped the v2 `NagSuppressions` helper in favor of the CDK
 * acknowledged-rules mechanism: `Validations.of(scope).acknowledge(...)` records the
 * acknowledgment as construct metadata, and the nag pack walks up the construct tree
 * looking for it. An acknowledgment therefore covers its scope and everything below
 * it, so make it on the narrowest construct that has the finding. A rule-level ID at
 * stack scope silences that rule for every resource in the stack.
 *
 * The S1 acknowledgment for the access logs bucket lives on that bucket, inside
 * ManagedKbStack, for this reason.
 */
cdk.Validations.of(stack).acknowledge({
  // Stack scope is safe here because the ID names one exact finding, not the whole
  // rule. If the data bucket's construct ID ever changes, its logical ID hash changes
  // with it and this string must be updated - `cdk synth` prints the replacement to use.
  id: 'AwsSolutions-IAM5[Resource::<KnowledgeBaseDataBucket5C146177.Arn>/*]',
  reason:
    'The knowledge base service role needs s3:GetObject across the whole data bucket so ' +
    'Bedrock can ingest any document the user uploads. Narrowed with an ' +
    'aws:ResourceAccount condition rather than by object key.',
});

/**
 * In cdk-nag v3 the packs are CDK validation plugins (they implement `validate`), not
 * Aspects as they were in v2. Plugins register at App or Stage scope.
 *
 * The constructor is `(scope, props)`. Passing the options object as the only argument
 * runs without error but binds it to `scope`, so every option is silently ignored.
 */
cdk.Validations.of(app).addPlugins(
  new AwsSolutionsChecks(app, {
    verbose: true,
    // Persist acknowledgments into template Metadata as `cdk_nag: { rules_to_suppress }`,
    // matching the v2 format that audit tooling expects.
    writeSuppressionsToCloudFormation: true,
  }),
);
