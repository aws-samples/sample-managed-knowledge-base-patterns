#!/usr/bin/env node
import * as os from "node:os";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { TabularSearchStack } from "../lib/tabular-search-stack";

const app = new cdk.App();

const name = String(app.node.getContext("name"));

/** Expand a leading ~, which the shell leaves alone in `-c dataDir=~/files`. */
function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/")
		? path.join(os.homedir(), value.slice(1))
		: value;
}

new TabularSearchStack(app, `tabular-search-${name}`, {
	description: "Tabular search in Amazon Bedrock Managed Knowledge Base (sample)",
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: process.env.CDK_DEFAULT_REGION,
	},
	name,
	// Relative paths are relative to infra/, where cdk runs.
	dataDir: path.resolve(expandHome(String(app.node.getContext("dataDir")))),
	maxFileSizeMb: Number(app.node.getContext("maxFileSizeMb")),
});

cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
