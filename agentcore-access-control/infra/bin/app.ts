#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { ManagedKbAclStack } from "../lib/managed-kb-acl-stack";

const app = new cdk.App();

/** Read a boolean context value that may come from `-c key=true`. */
function booleanContext(key: string): boolean {
  const value: unknown = app.node.tryGetContext(key);
  return value === true || value === "true";
}

new ManagedKbAclStack(app, "ManagedKbAclStack", {
  description:
    "Fine-grained access control for Amazon Bedrock Managed Knowledge Base MCP tools (sample)",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  agentModelId: app.node.getContext("agentModelId") as string,
  enableBypassSimulation: booleanContext("enableBypassSimulation"),
  allowLocalhostCallback: booleanContext("allowLocalhostCallback"),
});

cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
