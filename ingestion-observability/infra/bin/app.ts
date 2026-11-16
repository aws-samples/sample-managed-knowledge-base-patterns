#!/usr/bin/env node
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { AwsSolutionsChecks } from "cdk-nag";
import { IngestionObservabilityStack } from "../lib/ingestion-observability-stack";

const app = new cdk.App();

/** A context value as text: cdk.json values keep their type, -c values are strings. */
function text(key: string): string {
	const value: unknown = app.node.tryGetContext(key);
	return value === undefined || value === null ? "" : String(value).trim();
}

function flag(key: string): boolean {
	const value = text(key);
	if (value === "true" || value === "false") {
		return value === "true";
	}
	throw new Error(`Context ${key} must be true or false, not "${value}".`);
}

function number(key: string): number {
	const value = Number(text(key));
	if (text(key) === "" || !Number.isFinite(value)) {
		throw new Error(`Context ${key} must be a number, not "${text(key)}".`);
	}
	return value;
}

const name = text("name");

new IngestionObservabilityStack(app, `ingestion-observability-${name}`, {
	description: "EventBridge events for Amazon Bedrock Managed Knowledge Base sync start and finish (sample)",
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: process.env.CDK_DEFAULT_REGION,
	},
	name,
	deployDemo: flag("deployDemo"),
	dataDir: path.join(__dirname, "..", "..", "data", "docs"),
	// Comma-separated, such as -c knowledgeBaseIds=EXAMPLEKB1,EXAMPLEKB2.
	knowledgeBaseIds: text("knowledgeBaseIds")
		.split(",")
		.map((kbId) => kbId.trim())
		.filter((kbId) => kbId !== ""),
	existingLogGroupName: text("existingLogGroupName") || undefined,
	eventBusName: text("eventBusName"),
	eventSource: text("eventSource"),
	pollIntervalSeconds: number("pollIntervalSeconds"),
	jitterSeconds: number("jitterSeconds"),
	maxJobDuration: cdk.Duration.hours(number("maxJobDurationHours")),
	sweepEnabled: flag("sweepEnabled"),
	sweepSchedule: scheduler.ScheduleExpression.rate(
		cdk.Duration.minutes(number("sweepIntervalMinutes")),
	),
	sweepRps: number("sweepRps"),
	// Jobs that started before this are never announced by the sweep. A
	// deploy without -c sweepEpoch moves it to the synth time.
	sweepEpoch: text("sweepEpoch") || new Date().toISOString(),
	captureEvents: flag("captureEvents"),
	demoSyncDay: text("demoSyncDay").toUpperCase() || undefined,
});

cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
