#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { resolveAccount, resolveRegion, resolveSampleOptions } from '../lib/config';
import { STACK_NAME } from '../lib/names';
import { RetrievalInstructionsSampleStack } from '../lib/sample-stack';

const app = new cdk.App();

// AWS_REGION when it is set, else us-east-1, the same rule as both SDK programs.
const region = resolveRegion(process.env);
const account = resolveAccount(app.node.tryGetContext('account'), process.env);
const options = resolveSampleOptions(app.node, { account });

new RetrievalInstructionsSampleStack(app, STACK_NAME, {
  env: { account, region },
  description:
    'Per-tenant retrieval instructions for Amazon Bedrock Managed Knowledge Base (sample)',
  options,
});

/**
 * In cdk-nag v3 the packs are CDK validation plugins, registered at App scope. A
 * finding that isn't acknowledged fails synth. The constructor is (scope, props).
 */
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
