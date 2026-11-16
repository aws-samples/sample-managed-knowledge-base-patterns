import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { AwsSolutionsChecks } from "cdk-nag";
import {
	EVENTS_PER_POLL,
	FINISHED_DETAIL_TYPE,
	RETRYABLE_ERRORS,
} from "../lib/ingestion-observability";
import {
	IngestionObservabilityStack,
	IngestionObservabilityStackProps,
} from "../lib/ingestion-observability-stack";

const CDK_JSON_CONTEXT: Record<string, unknown> = JSON.parse(
	fs.readFileSync(path.join(__dirname, "..", "cdk.json"), "utf8"),
).context;

const ACCOUNT = "111122223333";
const REGION = "us-east-1";
const DATA_DIR = path.join(__dirname, "..", "..", "data", "docs");
const EXISTING_LOG_GROUP = "/aws/vendedlogs/bedrock/existing-kbs";
const KB1 = "EXAMPLEKB1";
const KB2 = "EXAMPLEKB2";
const BUS_ARN = `arn:aws:events:${REGION}:${ACCOUNT}:event-bus/default`;
const kbArn = (kbId: string): string => `arn:aws:bedrock:${REGION}:${ACCOUNT}:knowledge-base/${kbId}`;

/** Existing-log-group mode on two literal knowledge bases. */
const EXISTING: Partial<IngestionObservabilityStackProps> = {
	deployDemo: false,
	knowledgeBaseIds: [KB1, KB2],
	existingLogGroupName: EXISTING_LOG_GROUP,
};

function createStack(
	overrides: Partial<IngestionObservabilityStackProps> = {},
	environmentAgnostic = false,
): { app: cdk.App; stack: IngestionObservabilityStack } {
	// Synthesize with the feature flags of cdk.json, which change rendered
	// values such as ARN partitions.
	const app = new cdk.App({ context: CDK_JSON_CONTEXT });
	cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
	const stack = new IngestionObservabilityStack(app, "TestStack", {
		env: { account: ACCOUNT, region: REGION },
		...(environmentAgnostic ? { env: undefined } : {}),
		name: "demo",
		deployDemo: true,
		dataDir: DATA_DIR,
		knowledgeBaseIds: [],
		sweepEpoch: "2026-11-15T12:00:00.000Z",
		...overrides,
	});
	return { app, stack };
}

function synthesize(overrides: Partial<IngestionObservabilityStackProps> = {}): Template {
	return Template.fromStack(createStack(overrides).stack);
}

/** Return the only resource of a type, failing if there are none or several. */
function only(template: Template, type: string, props?: unknown): { id: string; resource: any } {
	const resources = Object.entries(template.findResources(type, props));
	expect(resources).toHaveLength(1);
	const [id, resource] = resources[0];
	return { id, resource };
}

/** The logical ID that starts with the construct path, such as IngestionObservabilityStartFunction. */
function idOf(template: Template, type: string, prefix: string): string {
	const ids = Object.keys(template.findResources(type)).filter((id) =>
		new RegExp(`^${prefix}[0-9A-F]{8}$`).test(id),
	);
	expect(ids).toHaveLength(1);
	return ids[0];
}

function statements(template: Template, policyPrefix: string): unknown[] {
	const id = idOf(template, "AWS::IAM::Policy", policyPrefix);
	return template.toJSON().Resources[id].Properties.PolicyDocument.Statement;
}

/**
 * The state machine definition as an object. It is a Fn::Join of the
 * definition text and the partition, which is the only token in it.
 */
function definition(template: Template): any {
	const sm = only(template, "AWS::StepFunctions::StateMachine").resource;
	const [, parts] = sm.Properties.DefinitionString["Fn::Join"];
	const text = parts
		.map((part: unknown) => {
			if (typeof part === "string") {
				return part;
			}
			expect(part).toEqual({ Ref: "AWS::Partition" });
			return "aws";
		})
		.join("");
	return JSON.parse(text);
}

function environment(template: Template, prefix: string): Record<string, unknown> {
	const id = idOf(template, "AWS::Lambda::Function", prefix);
	return template.toJSON().Resources[id].Properties.Environment.Variables;
}

describe("cdk-nag", () => {
	// An unacknowledged finding makes synth throw.
	test.each([
		["the demo stack", {}, false],
		["the demo stack without an account or Region", {}, true],
		["existing-log-group mode", EXISTING, false],
		["existing-log-group mode without an account or Region", EXISTING, true],
		["the demo stack without the sweep or the capture", { sweepEnabled: false, captureEvents: false }, false],
	])("%s passes the AwsSolutions checks", (_name, overrides, agnostic) => {
		const { app } = createStack(overrides as Partial<IngestionObservabilityStackProps>, agnostic as boolean);
		expect(() => app.synth()).not.toThrow();
	});
});

describe("log delivery", () => {
	test("the demo stack creates a log group, one destination, and a source and delivery per knowledge base", () => {
		const template = synthesize({ knowledgeBaseIds: [KB1, KB2] });
		const logGroup = idOf(template, "AWS::Logs::LogGroup", "IngestionObservabilityIngestionLogs");
		expect(template.toJSON().Resources[logGroup].Properties.LogGroupName).toBe(
			"/aws/vendedlogs/bedrock/demo",
		);
		template.resourceCountIs("AWS::Logs::DeliveryDestination", 1);
		template.resourceCountIs("AWS::Logs::DeliverySource", 3);
		template.resourceCountIs("AWS::Logs::Delivery", 3);
		template.hasResourceProperties("AWS::Logs::DeliverySource", {
			Name: `demo-${KB1}`,
			LogType: "APPLICATION_LOGS",
			ResourceArn: kbArn(KB1),
		});
		const delivery = only(template, "AWS::Logs::Delivery", {
			Properties: { DeliverySourceName: `demo-${KB2}` },
		}).resource;
		expect(delivery.DependsOn).toContain(
			idOf(template, "AWS::Logs::DeliverySource", `IngestionObservability${KB2}DeliverySource`),
		);
		template.hasResourceProperties("AWS::Logs::SubscriptionFilter", {
			LogGroupName: { Ref: logGroup },
		});
	});

	test("existing-log-group mode creates no delivery and filters the given log group", () => {
		const template = synthesize(EXISTING);
		template.resourceCountIs("AWS::Logs::DeliverySource", 0);
		template.resourceCountIs("AWS::Logs::Delivery", 0);
		template.resourceCountIs("AWS::Logs::DeliveryDestination", 0);
		template.hasResourceProperties("AWS::Logs::SubscriptionFilter", {
			LogGroupName: EXISTING_LOG_GROUP,
		});
		template.hasOutput("IngestionLogGroup", { Value: EXISTING_LOG_GROUP });
	});

	test("the subscription filter matches only start records and invokes the Start function", () => {
		const template = synthesize();
		const start = idOf(template, "AWS::Lambda::Function", "IngestionObservabilityStartFunction");
		template.hasResourceProperties("AWS::Logs::SubscriptionFilter", {
			FilterName: "demo-ingestion-started",
			FilterPattern: '{ $.event.ingestion_job_status = "INGESTION_JOB_STARTED" }',
			DestinationArn: { "Fn::GetAtt": [start, "Arn"] },
		});
		template.hasResourceProperties("AWS::Lambda::Permission", {
			Action: "lambda:InvokeFunction",
			FunctionName: { "Fn::GetAtt": [start, "Arn"] },
			Principal: "logs.amazonaws.com",
		});
	});
});

describe("claim table", () => {
	test("has a string partition key, TTL, and point-in-time recovery", () => {
		synthesize().hasResourceProperties("AWS::DynamoDB::Table", {
			KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
			BillingMode: "PAY_PER_REQUEST",
			TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
			PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
		});
	});
});

describe("functions", () => {
	const template = synthesize(EXISTING);
	const table = idOf(template, "AWS::DynamoDB::Table", "IngestionObservabilityClaims");
	const stateMachine = idOf(template, "AWS::StepFunctions::StateMachine", "IngestionObservabilityPoller");
	const claimStatements = [
		{ Action: "events:PutEvents", Effect: "Allow", Resource: BUS_ARN },
		{
			Action: ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
			Effect: "Allow",
			Resource: { "Fn::GetAtt": [table, "Arn"] },
		},
		{ Action: "states:StartExecution", Effect: "Allow", Resource: { Ref: stateMachine } },
	];

	test("the Start function can only announce and claim", () => {
		expect(
			statements(template, "IngestionObservabilityStartFunctionServiceRoleDefaultPolicy"),
		).toEqual(claimStatements);
	});

	test("the Sweep function can also list data sources and jobs of the tracked knowledge bases", () => {
		expect(
			statements(template, "IngestionObservabilitySweepFunctionServiceRoleDefaultPolicy"),
		).toEqual([
			{
				Action: ["bedrock:ListDataSources", "bedrock:ListIngestionJobs"],
				Effect: "Allow",
				// AWS CDK sorts the resources.
				Resource: [kbArn(KB1), kbArn(KB2)].sort(),
			},
			...claimStatements,
		]);
	});

	test("the poller can only read jobs of the tracked knowledge bases, log, and announce", () => {
		expect(statements(template, "IngestionObservabilityPollerRoleDefaultPolicy")).toEqual([
			{
				Action: "bedrock:GetIngestionJob",
				Effect: "Allow",
				// AWS CDK sorts the resources.
				Resource: [kbArn(KB1), kbArn(KB2)].sort(),
			},
			{
				// Added by AWS CDK for the logging configuration (acknowledged).
				Action: [
					"logs:CreateLogDelivery",
					"logs:DeleteLogDelivery",
					"logs:DescribeLogGroups",
					"logs:DescribeResourcePolicies",
					"logs:GetLogDelivery",
					"logs:ListLogDeliveries",
					"logs:PutResourcePolicy",
					"logs:UpdateLogDelivery",
				],
				Effect: "Allow",
				Resource: "*",
			},
			{ Action: "events:PutEvents", Effect: "Allow", Resource: BUS_ARN },
		]);
	});

	test("both functions get the claim settings, and the sweep gets its own", () => {
		const shared = {
			TABLE_NAME: { Ref: table },
			STATE_MACHINE_ARN: { Ref: stateMachine },
			EVENT_BUS_NAME: "default",
			EVENT_SOURCE: "custom.bedrock.kb-ingestion",
			CLAIM_LEASE_SECONDS: "300",
			TRACKED_KNOWLEDGE_BASE_IDS: `${KB1},${KB2}`,
		};
		expect(environment(template, "IngestionObservabilityStartFunction")).toEqual(shared);
		expect(environment(template, "IngestionObservabilitySweepFunction")).toEqual({
			...shared,
			SWEEP_EPOCH: "2026-11-15T12:00:00.000Z",
			SWEEP_RPS: "2",
			KNOWLEDGE_BASE_ARN_PREFIX: `arn:aws:bedrock:${REGION}:${ACCOUNT}:knowledge-base/`,
		});
	});

	test("the functions run Python 3.14 from functions/", () => {
		for (const [prefix, handler] of [
			["IngestionObservabilityStartFunction", "start.handler"],
			["IngestionObservabilitySweepFunction", "sweep.handler"],
		]) {
			const id = idOf(template, "AWS::Lambda::Function", prefix);
			expect(template.toJSON().Resources[id].Properties).toMatchObject({
				Runtime: "python3.14",
				Handler: handler,
			});
		}
	});

	test("the sweep runs one at a time every 15 minutes", () => {
		const sweep = idOf(template, "AWS::Lambda::Function", "IngestionObservabilitySweepFunction");
		expect(template.toJSON().Resources[sweep].Properties).toMatchObject({
			ReservedConcurrentExecutions: 1,
			Timeout: 240,
			MemorySize: 256,
		});
		template.hasResourceProperties("AWS::Scheduler::Schedule", {
			ScheduleExpression: "rate(15 minutes)",
			Target: { Arn: { "Fn::GetAtt": [sweep, "Arn"] } },
		});
	});

	test("the demo knowledge base is tracked first", () => {
		const env = environment(
			synthesize({ knowledgeBaseIds: [KB1] }),
			"IngestionObservabilitySweepFunction",
		);
		expect(env.TRACKED_KNOWLEDGE_BASE_IDS).toEqual({
			"Fn::Join": ["", [{ "Fn::GetAtt": ["DemoKnowledgeBase", "KnowledgeBaseId"] }, `,${KB1}`]],
		});
	});

	test("sweepEnabled=false creates no schedule", () => {
		synthesize({ sweepEnabled: false }).resourceCountIs("AWS::Scheduler::Schedule", 0);
	});

	test("sweepSchedule sets the schedule", () => {
		synthesize({
			sweepSchedule: scheduler.ScheduleExpression.rate(cdk.Duration.hours(1)),
		}).hasResourceProperties("AWS::Scheduler::Schedule", { ScheduleExpression: "rate(1 hour)" });
	});
});

describe("poller", () => {
	const template = synthesize();
	const asl = definition(template);
	const states = asl.States;

	test("is a Standard state machine in JSONata that logs ALL without execution data", () => {
		expect(asl.QueryLanguage).toBe("JSONata");
		expect(asl.StartAt).toBe("Init");
		const sm = only(template, "AWS::StepFunctions::StateMachine").resource;
		expect(sm.Properties.StateMachineType).toBe("STANDARD");
		expect(sm.Properties.LoggingConfiguration).toMatchObject({ Level: "ALL", IncludeExecutionData: false });
		const logGroup = idOf(template, "AWS::Logs::LogGroup", "IngestionObservabilityPollerLogs");
		expect(template.toJSON().Resources[logGroup].Properties.LogGroupName).toBe(
			"/aws/vendedlogs/states/demo-poller",
		);
	});

	test("has the measured loop shape: Init, IncrementPollCount, PollCapReached, Wait, GetIngestionJob, IsTerminal", () => {
		expect(states.Init.Next).toBe("IncrementPollCount");
		expect(states.IncrementPollCount.Next).toBe("PollCapReached");
		expect(states.PollCapReached.Choices).toEqual([
			{
				Condition: "{% $toMillis($now()) >= $deadlineMillis or $pollCount > $maxPolls %}",
				Next: "EmitTimeout",
			},
		]);
		expect(states.PollCapReached.Default).toBe("Wait");
		expect(states.Wait.Next).toBe("GetIngestionJob");
		expect(states.GetIngestionJob.Next).toBe("IsTerminal");
		expect(states.IsTerminal.Choices).toEqual([
			{
				Condition: "{% $states.input.IngestionJob.Status in ['COMPLETE', 'FAILED', 'STOPPED'] %}",
				Next: "EmitFinished",
			},
		]);
		expect(states.IsTerminal.Default).toBe("IncrementPollCount");
		// Each loop iteration enters exactly these 5 states (13 events).
		expect(EVENTS_PER_POLL).toBe(13);
	});

	test("Init sets maxPolls to ceil(24 h / 60 s) = 1440 and seeds the loop variables", () => {
		expect(states.Init.Assign).toMatchObject({
			maxPolls: 1440,
			pollIntervalSeconds: 60,
			jitterSeconds: 10,
			pollCount: 0,
			ingestionJobId: "{% $states.input.ingestionJobId %}",
			detectedBy: "{% $states.input.detectedBy %}",
		});
	});

	test("Init sets the deadline to the execution start plus 24 h, so jitter can't extend it", () => {
		expect(states.Init.Assign.jitterSeconds).toBe(10);
		expect(states.Init.Assign.deadlineMillis).toBe(
			"{% $toMillis($states.context.Execution.StartTime) + 86400000 %}",
		);
	});

	test("the wait has jitter from $random() in IncrementPollCount", () => {
		expect(states.IncrementPollCount.Assign).toEqual({
			pollCount: "{% $pollCount + 1 %}",
			waitSeconds: "{% $pollIntervalSeconds + $floor($random() * ($jitterSeconds + 1)) %}",
		});
		expect(states.Wait.Seconds).toBe("{% $waitSeconds %}");
	});

	test("GetIngestionJob uses the SDK integration with PascalCase arguments", () => {
		expect(states.GetIngestionJob).toMatchObject({
			Type: "Task",
			Resource: "arn:aws:states:::aws-sdk:bedrockagent:getIngestionJob",
			Arguments: {
				KnowledgeBaseId: "{% $knowledgeBaseId %}",
				DataSourceId: "{% $dataSourceId %}",
				IngestionJobId: "{% $ingestionJobId %}",
			},
		});
	});

	test("GetIngestionJob retries the retryable errors with full jitter, then catches them before States.ALL", () => {
		expect(RETRYABLE_ERRORS).toEqual([
			"BedrockAgent.ThrottlingException",
			"BedrockAgent.InternalServerException",
		]);
		expect(states.GetIngestionJob.Retry).toEqual([
			{
				ErrorEquals: RETRYABLE_ERRORS,
				IntervalSeconds: 5,
				BackoffRate: 2,
				MaxAttempts: 6,
				JitterStrategy: "FULL",
			},
		]);
		expect(states.GetIngestionJob.Catch).toEqual([
			{ ErrorEquals: RETRYABLE_ERRORS, Next: "IncrementPollCount" },
			{ ErrorEquals: ["States.ALL"], Output: "{% $states.errorOutput %}", Next: "EmitUnknownError" },
		]);
	});

	test.each([
		["EmitFinished", "Finished", "Succeed"],
		["EmitTimeout", "TimedOut", "Fail"],
		["EmitUnknownError", "PollFailed", "Fail"],
	])("%s sends one Finished entry with the knowledge base as the resource, then %s", (id, next, type) => {
		const state = states[id];
		expect(state).toMatchObject({
			Type: "Task",
			Resource: "arn:aws:states:::events:putEvents",
			Next: next,
			Retry: [{ ErrorEquals: ["States.ALL"], MaxAttempts: 3 }],
		});
		expect(state.Catch).toBeUndefined();
		expect(state.Arguments.Entries).toHaveLength(1);
		expect(state.Arguments.Entries[0]).toMatchObject({
			Source: "custom.bedrock.kb-ingestion",
			DetailType: FINISHED_DETAIL_TYPE,
			EventBusName: "default",
			Resources: ["{% $knowledgeBaseArn %}"],
		});
		expect(states[next].Type).toBe(type);
	});

	test("the Finished detail maps the API fields, caps the failure reasons, and keeps the provenance", () => {
		const detail: string = states.EmitFinished.Arguments.Entries[0].Detail;
		expect(detail.startsWith("{% ")).toBe(true);
		expect(detail.endsWith(" %}")).toBe(true);
		for (const fragment of [
			'"status": $job.Status',
			'"durationSeconds": $round(($toMillis($job.UpdatedAt) - $toMillis($job.StartedAt)) / 1000)',
			'"numberOfDocumentsFailed": $stats.NumberOfDocumentsFailed',
			'"hasDocumentFailures": $exists($stats.NumberOfDocumentsFailed) and $stats.NumberOfDocumentsFailed > 0',
			"$map($reasons[[0..19]], function($r) { $substring($r, 0, 2000) })",
			'"failureReasonsTruncated": $count($reasons) > 20 or $count($reasons[$length($) > 2000]) > 0',
			'"textReadyAt": $job.TextReadyAt',
			'"detectedBy": $detectedBy',
			'"trigger": $trigger',
		]) {
			expect(detail).toContain(fragment);
		}
	});

	test("the UNKNOWN_* details carry no API fields, and UNKNOWN_ERROR adds the error and cause", () => {
		const timeout: string = states.EmitTimeout.Arguments.Entries[0].Detail;
		const error: string = states.EmitUnknownError.Arguments.Entries[0].Detail;
		expect(timeout).toContain('"status": "UNKNOWN_TIMEOUT"');
		expect(error).toContain('"status": "UNKNOWN_ERROR"');
		expect(error).toContain('"error": $states.input.Error');
		expect(error).toContain('"cause": $substring($states.input.Cause, 0, 2000)');
		for (const detail of [timeout, error]) {
			expect(detail).not.toContain("statistics");
			expect(detail).not.toContain("updatedAt");
			expect(detail).not.toContain("failureReasons");
		}
	});

	test("an alarm fires on any failed execution", () => {
		const stateMachine = idOf(template, "AWS::StepFunctions::StateMachine", "IngestionObservabilityPoller");
		template.hasResourceProperties("AWS::CloudWatch::Alarm", {
			Namespace: "AWS/States",
			MetricName: "ExecutionsFailed",
			Dimensions: [{ Name: "StateMachineArn", Value: { Ref: stateMachine } }],
			Statistic: "Sum",
			Period: 300,
			Threshold: 1,
			ComparisonOperator: "GreaterThanOrEqualToThreshold",
			TreatMissingData: "notBreaching",
		});
	});

	test("a custom bus is used by the poller, the functions, and the capture rule", () => {
		const custom = synthesize({ eventBusName: "kb-events" });
		const entries = definition(custom).States.EmitFinished.Arguments.Entries;
		expect(entries[0].EventBusName).toBe("kb-events");
		const busArn = `arn:aws:events:${REGION}:${ACCOUNT}:event-bus/kb-events`;
		expect(statements(custom, "IngestionObservabilityPollerRoleDefaultPolicy")).toContainEqual({
			Action: "events:PutEvents",
			Effect: "Allow",
			Resource: busArn,
		});
		expect(statements(custom, "IngestionObservabilityStartFunctionServiceRoleDefaultPolicy")).toContainEqual({
			Action: "events:PutEvents",
			Effect: "Allow",
			Resource: busArn,
		});
		custom.hasResourceProperties("AWS::Events::Rule", { EventBusName: "kb-events" });
	});
});

describe("validation", () => {
	test("30 s polls over 24 h exceed the history budget", () => {
		expect(() => createStack({ pollIntervalSeconds: 30 })).toThrow(/pollIntervalSeconds >= 57/);
	});

	test("30 s polls over 12 h fit the history budget", () => {
		const template = synthesize({ pollIntervalSeconds: 30, maxJobDuration: cdk.Duration.hours(12) });
		expect(definition(template).States.Init.Assign.maxPolls).toBe(1440);
	});

	test("the deadline follows maxJobDuration, not the poll count, with non-zero jitter", () => {
		const assign = definition(
			synthesize({ jitterSeconds: 30, maxJobDuration: cdk.Duration.hours(2) }),
		).States.Init.Assign;
		expect(assign.jitterSeconds).toBe(30);
		expect(assign.maxPolls).toBe(120);
		expect(assign.deadlineMillis).toBe(
			"{% $toMillis($states.context.Execution.StartTime) + 7200000 %}",
		);
	});

	test("57 s is the smallest interval that fits 24 h", () => {
		expect(() => createStack({ pollIntervalSeconds: 57 })).not.toThrow();
		expect(() => createStack({ pollIntervalSeconds: 56 })).toThrow(/history events/);
	});

	test("a lease that doesn't exceed the sweep timeout is rejected", () => {
		expect(() => createStack({ claimLeaseSeconds: 240 })).toThrow(/claimLeaseSeconds/);
		expect(() => createStack({ claimLeaseSeconds: 241 })).not.toThrow();
	});

	test("the default lease follows a longer sweep timeout", () => {
		const env = environment(
			synthesize({ sweepFunctionTimeout: cdk.Duration.seconds(900) }),
			"IngestionObservabilityStartFunction",
		);
		expect(env.CLAIM_LEASE_SECONDS).toBe("960");
	});

	test.each(["examplekb1", "EXAMPLEKB", "EXAMPLEKB11", "EXAMPLE-K1"])(
		"rejects the knowledge base ID %p",
		(kbId) => {
			expect(() => createStack({ knowledgeBaseIds: [kbId] })).toThrow(/Knowledge base ID/);
		},
	);

	test.each(["F", "a", "bad--name", "-demo", "demo_kb", "x".repeat(33)])("rejects the name %p", (name) => {
		expect(() => createStack({ name })).toThrow(/lowercase letters/);
	});

	test.each([
		[{ jitterSeconds: -1 }, /jitterSeconds/],
		[{ jitterSeconds: 1.5 }, /jitterSeconds/],
		[{ pollIntervalSeconds: 0 }, /pollIntervalSeconds/],
		[{ sweepRps: 0 }, /sweepRps/],
		[{ sweepRps: 11 }, /sweepRps/],
		[{ sweepEpoch: "yesterday" }, /sweepEpoch/],
	])("rejects %p", (overrides, message) => {
		expect(() => createStack(overrides as Partial<IngestionObservabilityStackProps>)).toThrow(message);
	});

	test("jitterSeconds=0 turns jitter off", () => {
		expect(definition(synthesize({ jitterSeconds: 0 })).States.Init.Assign.jitterSeconds).toBe(0);
	});

	test("no knowledge base and no demo is rejected", () => {
		expect(() => createStack({ deployDemo: false })).toThrow(/knowledgeBaseIds/);
	});

	test("the demo with existing-log-group mode is rejected", () => {
		expect(() => createStack({ existingLogGroupName: EXISTING_LOG_GROUP })).toThrow(
			/existingLogGroupName/,
		);
	});
});

describe("demo and capture", () => {
	test("the demo knowledge base is a managed knowledge base over the demo bucket, with no schedule", () => {
		const template = synthesize();
		const bucket = only(template, "AWS::S3::Bucket").id;
		template.hasResourceProperties("AWS::Bedrock::KnowledgeBase", {
			Name: "demo-demo-kb",
			KnowledgeBaseConfiguration: {
				Type: "MANAGED",
				ManagedKnowledgeBaseConfiguration: { EmbeddingModelType: "MANAGED" },
			},
		});
		const dataSource = only(template, "AWS::Bedrock::DataSource").resource;
		expect(dataSource.Properties).toMatchObject({
			Name: "demo-demo-s3",
			DataDeletionPolicy: "DELETE",
			DataSourceConfiguration: {
				ManagedKnowledgeBaseConnectorConfiguration: {
					ConnectorParameters: {
						type: "S3",
						connectionConfiguration: { bucketName: { Ref: bucket } },
						filterConfiguration: { inclusionPrefixes: ["docs/"] },
					},
				},
			},
		});
		expect(
			dataSource.Properties.DataSourceConfiguration.ManagedKnowledgeBaseConnectorConfiguration
				.SyncSchedule,
		).toBeUndefined();
		for (const output of ["DemoKnowledgeBaseId", "DemoDataSourceId", "DemoKnowledgeBaseRoleName", "BucketName"]) {
			template.hasOutput(output, {});
		}
	});
	test("demoSyncDay gives the demo data source a weekly schedule", () => {
		const dataSource = only(synthesize({ demoSyncDay: "MONDAY" }), "AWS::Bedrock::DataSource").resource;
		expect(
			dataSource.Properties.DataSourceConfiguration.ManagedKnowledgeBaseConnectorConfiguration
				.SyncSchedule,
		).toEqual({ Weekly: { DayOfWeek: "MONDAY" } });
	});

	test("the demo knowledge base role trusts Bedrock in this account and only reads the bucket", () => {
		const template = synthesize();
		const bucket = only(template, "AWS::S3::Bucket").id;
		const role = only(template, "AWS::IAM::Role", {
			Properties: { Description: Match.stringLikeRegexp("demo files") },
		}).resource;
		expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
			{
				Action: "sts:AssumeRole",
				Effect: "Allow",
				Principal: { Service: "bedrock.amazonaws.com" },
				Condition: {
					StringEquals: { "aws:SourceAccount": ACCOUNT },
					ArnLike: { "aws:SourceArn": `arn:aws:bedrock:${REGION}:${ACCOUNT}:knowledge-base/*` },
				},
			},
		]);
		const sameAccount = { StringEquals: { "aws:ResourceAccount": ACCOUNT } };
		expect(role.Properties.Policies).toEqual([
			{
				PolicyName: "demo-demo-kb-s3-read",
				PolicyDocument: {
					Version: "2012-10-17",
					Statement: [
						{
							Sid: "ListBucket",
							Action: "s3:ListBucket",
							Effect: "Allow",
							Resource: { "Fn::GetAtt": [bucket, "Arn"] },
							Condition: sameAccount,
						},
						{
							Sid: "ReadObjects",
							Action: "s3:GetObject",
							Effect: "Allow",
							Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": [bucket, "Arn"] }, "/*"]] },
							Condition: sameAccount,
						},
					],
				},
			},
		]);
	});

	test("deployDemo=false creates no knowledge base, data source, or bucket", () => {
		const template = synthesize(EXISTING);
		template.resourceCountIs("AWS::Bedrock::KnowledgeBase", 0);
		template.resourceCountIs("AWS::Bedrock::DataSource", 0);
		template.resourceCountIs("AWS::S3::Bucket", 0);
		template.resourceCountIs("Custom::CDKBucketDeployment", 0);
		expect(Object.keys(template.toJSON().Outputs)).not.toContain("DemoKnowledgeBaseId");
	});

	test("the capture rule writes every event of the source to a log group the stack's policy opens", () => {
		const template = synthesize();
		const logGroup = only(template, "AWS::Logs::LogGroup", {
			Properties: { LogGroupName: "/ingestion-observability/demo/events" },
		}).id;
		const rule = only(template, "AWS::Events::Rule").resource;
		expect(rule.Properties.EventPattern).toEqual({ source: ["custom.bedrock.kb-ingestion"] });
		expect(rule.Properties.Targets).toEqual([
			{
				Arn: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/ingestion-observability/demo/events`,
				Id: "Target0",
			},
		]);
		const policy = only(template, "AWS::Logs::ResourcePolicy");
		expect(rule.DependsOn).toContain(policy.id);
		expect(policy.resource.Properties.PolicyName).toBe("ingestion-observability-demo-events");
		const document = JSON.parse(
			policy.resource.Properties.PolicyDocument["Fn::Join"][1]
				.map((part: unknown) => (typeof part === "string" ? part : "LOG_GROUP_ARN"))
				.join(""),
		);
		expect(policy.resource.Properties.PolicyDocument["Fn::Join"][1][1]).toEqual({
			"Fn::GetAtt": [logGroup, "Arn"],
		});
		expect(document.Statement).toEqual([
			{
				Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
				Effect: "Allow",
				Principal: { Service: ["events.amazonaws.com", "delivery.logs.amazonaws.com"] },
				Resource: "LOG_GROUP_ARN",
			},
		]);
		template.hasOutput("EventLogGroup", { Value: { Ref: logGroup } });
	});

	test("captureEvents=false creates no rule, policy, or event log group", () => {
		const template = synthesize({ captureEvents: false });
		template.resourceCountIs("AWS::Events::Rule", 0);
		template.resourceCountIs("AWS::Logs::ResourcePolicy", 0);
		expect(
			Object.values(template.findResources("AWS::Logs::LogGroup")).map(
				(logGroup) => logGroup.Properties.LogGroupName,
			),
		).not.toContain("/ingestion-observability/demo/events");
	});

	test("outputs the names and ARNs the README commands use", () => {
		const template = synthesize();
		for (const output of [
			"IngestionLogGroup",
			"EventLogGroup",
			"StateMachineArn",
			"ClaimTableName",
			"StartFunctionName",
			"SweepFunctionName",
			"FailedExecutionsAlarmName",
		]) {
			template.hasOutput(output, {});
		}
	});
});

describe.each([
	["the demo stack", {}],
	["existing-log-group mode", EXISTING],
])("clean up and log groups: %s", (_name, overrides) => {
	const template = synthesize(overrides as Partial<IngestionObservabilityStackProps>);
	const logGroups = template.findResources("AWS::Logs::LogGroup");

	test("no resource is retained when the stack is deleted", () => {
		for (const resource of Object.values(template.toJSON().Resources) as any[]) {
			expect(resource.DeletionPolicy ?? "Delete").toBe("Delete");
		}
	});

	test("every log group is deleted with the stack and keeps events for 30 days", () => {
		expect(Object.keys(logGroups).length).toBeGreaterThan(0);
		for (const logGroup of Object.values(logGroups)) {
			expect(logGroup.DeletionPolicy).toBe("Delete");
			expect(logGroup.Properties.RetentionInDays).toBe(30);
		}
	});

	test("every Lambda function logs to a log group of the stack", () => {
		const functions = template.findResources("AWS::Lambda::Function");
		expect(Object.keys(functions).length).toBeGreaterThan(0);
		for (const fn of Object.values(functions)) {
			expect(Object.keys(logGroups)).toContain(fn.Properties.LoggingConfig?.LogGroup?.Ref);
		}
	});

	test("log groups are deleted after every role, so no function can recreate them", () => {
		for (const role of Object.values(template.findResources("AWS::IAM::Role"))) {
			expect(role.DependsOn).toEqual(expect.arrayContaining(Object.keys(logGroups)));
		}
	});

	// Keeps every function, including the CDK helpers, at 512 MB or less.
	test("no Lambda function asks for more than 512 MB of memory", () => {
		for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
			expect(fn.Properties.MemorySize ?? 128).toBeLessThanOrEqual(512);
		}
	});
});
