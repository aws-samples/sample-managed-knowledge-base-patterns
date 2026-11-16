import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as logsDestinations from "aws-cdk-lib/aws-logs-destinations";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

/**
 * History events per poll loop iteration: IncrementPollCount 2,
 * PollCapReached 2, Wait 2, GetIngestionJob 5, IsTerminal 2.
 */
export const EVENTS_PER_POLL = 13;

/**
 * Budget for the poll loop. A Standard execution's history holds up to
 * 25,000 events (see Step Functions service quotas); the rest covers the
 * fixed overhead outside the loop and some failed retry attempts (3 events
 * each).
 */
export const MAX_POLL_HISTORY_EVENTS = 20_000;

/**
 * GetIngestionJob errors that the poller retries. The AWS SDK integration
 * names errors `BedrockAgent.<ExceptionName>`, after the bedrock-agent
 * model's exceptions.
 */
export const RETRYABLE_ERRORS = [
	"BedrockAgent.ThrottlingException",
	"BedrockAgent.InternalServerException",
];

export const STARTED_DETAIL_TYPE = "Knowledge Base Ingestion Job Started";
export const FINISHED_DETAIL_TYPE = "Knowledge Base Ingestion Job Finished";

/** Knowledge base IDs are 10 uppercase letters and digits. */
export const KNOWLEDGE_BASE_ID_PATTERN = /^[0-9A-Z]{10}$/;

/** The Start and Sweep functions (claim.py, start.py, sweep.py). */
export const FUNCTIONS_DIR = path.join(__dirname, "..", "..", "functions");

export interface IngestionObservabilityProps {
	/** Prefix of the resource names, such as the log group and delivery names. */
	readonly name: string;
	/**
	 * Knowledge bases to track. Literal IDs are validated; tokens, such as
	 * the ID of a knowledge base in the same stack, are allowed.
	 */
	readonly knowledgeBaseIds: string[];
	/**
	 * Existing-log-group mode: the knowledge bases already deliver their
	 * APPLICATION_LOGS to this log group, so create no delivery and only add
	 * the subscription filter. Use this mode for knowledge bases that
	 * already have a delivery source.
	 *
	 * @default - create a log group, and a delivery source and delivery per knowledge base
	 */
	readonly existingLogGroupName?: string;
	/**
	 * The name of an existing event bus for the Started and Finished events.
	 *
	 * @default "default"
	 */
	readonly eventBusName?: string;
	/** @default "custom.bedrock.kb-ingestion" */
	readonly eventSource?: string;
	/** Seconds between polls of a running job. @default 60 */
	readonly pollIntervalSeconds?: number;
	/** Up to this many seconds are added to each wait at random; 0 turns it off. @default 10 */
	readonly jitterSeconds?: number;
	/**
	 * The poller gives up (status UNKNOWN_TIMEOUT) at its first poll after
	 * this long has passed since the execution started.
	 *
	 * @default Duration.hours(24)
	 */
	readonly maxJobDuration?: cdk.Duration;
	/** @default true */
	readonly sweepEnabled?: boolean;
	/** @default ScheduleExpression.rate(Duration.minutes(15)) */
	readonly sweepSchedule?: scheduler.ScheduleExpression;
	/** Calls per second to each of ListDataSources and ListIngestionJobs. @default 2 */
	readonly sweepRps?: number;
	/** ISO 8601 timestamp. The sweep never announces jobs that started before it. */
	readonly sweepEpoch: string;
	/** @default Duration.seconds(60) */
	readonly startFunctionTimeout?: cdk.Duration;
	/** @default Duration.seconds(240) */
	readonly sweepFunctionTimeout?: cdk.Duration;
	/**
	 * A claim older than this can be taken over. Must exceed both function
	 * timeouts, so a live claimer is never taken over.
	 *
	 * @default - the longer function timeout plus 60 seconds
	 */
	readonly claimLeaseSeconds?: number;
}

/**
 * Publishes EventBridge events when an ingestion job (sync) on an Amazon
 * Bedrock managed knowledge base starts and when it finishes.
 *
 * - Start: the vended log record INGESTION_JOB_STARTED reaches the Start
 *   function through a subscription filter. A scheduled sweep of
 *   ListIngestionJobs announces any job that the log path missed.
 * - Finish: a Step Functions poller started for each job calls
 *   GetIngestionJob until the job reaches COMPLETE, FAILED, or STOPPED.
 *
 * See "Design choices" in the README for why it's built this way.
 */
export class IngestionObservability extends Construct {
	readonly stateMachine: sfn.StateMachine;
	readonly table: dynamodb.Table;
	readonly startFunction: lambda.Function;
	readonly sweepFunction: lambda.Function;
	/** The log group that the subscription filter reads. */
	readonly logGroupName: string;
	readonly alarm: cloudwatch.Alarm;
	/**
	 * The most polls an execution makes, ceil(maxJobDuration / pollIntervalSeconds).
	 * It bounds the execution history; the elapsed-time deadline usually
	 * ends the loop first, because jitter makes each wait longer.
	 */
	readonly maxPolls: number;
	/** maxJobDuration in seconds; the poller's elapsed-time deadline. */
	readonly maxJobDurationSeconds: number;

	constructor(scope: Construct, id: string, props: IngestionObservabilityProps) {
		super(scope, id);
		const stack = cdk.Stack.of(this);

		const eventBusName = props.eventBusName ?? "default";
		const eventSource = props.eventSource ?? "custom.bedrock.kb-ingestion";
		const pollIntervalSeconds = props.pollIntervalSeconds ?? 60;
		const jitterSeconds = props.jitterSeconds ?? 10;
		const maxJobDuration = props.maxJobDuration ?? cdk.Duration.hours(24);
		const sweepEnabled = props.sweepEnabled ?? true;
		const sweepRps = props.sweepRps ?? 2;
		const startTimeout = props.startFunctionTimeout ?? cdk.Duration.seconds(60);
		const sweepTimeout = props.sweepFunctionTimeout ?? cdk.Duration.seconds(240);
		const longestTimeout = Math.max(startTimeout.toSeconds(), sweepTimeout.toSeconds());
		const claimLeaseSeconds = props.claimLeaseSeconds ?? longestTimeout + 60;

		validate(props, {
			pollIntervalSeconds,
			jitterSeconds,
			sweepRps,
			claimLeaseSeconds,
			longestTimeout,
		});
		this.maxJobDurationSeconds = maxJobDuration.toSeconds();
		this.maxPolls = Math.ceil(this.maxJobDurationSeconds / pollIntervalSeconds);
		if (this.maxPolls * EVENTS_PER_POLL > MAX_POLL_HISTORY_EVENTS) {
			const floor = Math.ceil(
				maxJobDuration.toSeconds() / Math.floor(MAX_POLL_HISTORY_EVENTS / EVENTS_PER_POLL),
			);
			throw new Error(
				`pollIntervalSeconds ${pollIntervalSeconds} with maxJobDuration ${maxJobDuration.toHumanString()} ` +
					`needs ${this.maxPolls} polls x ${EVENTS_PER_POLL} events = ${this.maxPolls * EVENTS_PER_POLL} ` +
					`history events, over the ${MAX_POLL_HISTORY_EVENTS} budget. Use pollIntervalSeconds >= ${floor} ` +
					"or a shorter maxJobDuration.",
			);
		}

		const knowledgeBaseArns = props.knowledgeBaseIds.map((kbId) =>
			stack.formatArn({ service: "bedrock", resource: "knowledge-base", resourceName: kbId }),
		);
		const eventBusArn = stack.formatArn({
			service: "events",
			resource: "event-bus",
			resourceName: eventBusName,
		});

		// Log delivery. One delivery source and delivery per knowledge base,
		// all to one log group.
		let logGroup: logs.ILogGroup;
		if (props.existingLogGroupName) {
			logGroup = logs.LogGroup.fromLogGroupName(this, "IngestionLogs", props.existingLogGroupName);
		} else {
			logGroup = new logs.LogGroup(this, "IngestionLogs", {
				logGroupName: `/aws/vendedlogs/bedrock/${props.name}`,
				retention: logs.RetentionDays.ONE_MONTH,
				removalPolicy: cdk.RemovalPolicy.DESTROY,
			});
			const destination = new logs.CfnDeliveryDestination(this, "DeliveryDestination", {
				name: `${props.name}-cwl`,
				destinationResourceArn: logGroup.logGroupArn,
				outputFormat: "json",
			});
			props.knowledgeBaseIds.forEach((kbId, index) => {
				const kbScope = new Construct(this, cdk.Token.isUnresolved(kbId) ? `Kb${index}` : kbId);
				const source = new logs.CfnDeliverySource(kbScope, "DeliverySource", {
					name: `${props.name}-${kbId}`,
					logType: "APPLICATION_LOGS",
					resourceArn: knowledgeBaseArns[index],
				});
				const delivery = new logs.CfnDelivery(kbScope, "Delivery", {
					deliverySourceName: source.name,
					deliveryDestinationArn: destination.attrArn,
				});
				delivery.addResourceDependency(source);
			});
		}
		this.logGroupName = logGroup.logGroupName;

		// Claims (job#<kbId>#<dsId>#<jobId>) and sweep watermarks (ds#<kbId>#<dsId>).
		this.table = new dynamodb.Table(this, "Claims", {
			partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
			billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
			timeToLiveAttribute: "ttl",
			pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		this.stateMachine = this.createPoller({
			name: props.name,
			knowledgeBaseArns,
			eventBusName,
			eventBusArn,
			eventSource,
			pollIntervalSeconds,
			jitterSeconds,
		});

		this.alarm = new cloudwatch.Alarm(this, "FailedExecutionsAlarm", {
			alarmDescription:
				"A poller execution failed: UNKNOWN_ERROR, UNKNOWN_TIMEOUT, an undelivered Finished event, or the history limit.",
			metric: this.stateMachine.metricFailed({
				period: cdk.Duration.minutes(5),
				statistic: cloudwatch.Stats.SUM,
			}),
			threshold: 1,
			evaluationPeriods: 1,
			comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
			treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
		});

		const code = lambda.Code.fromAsset(FUNCTIONS_DIR, {
			exclude: ["__pycache__", "*.pyc"],
		});
		const environment = {
			TABLE_NAME: this.table.tableName,
			STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
			EVENT_BUS_NAME: eventBusName,
			EVENT_SOURCE: eventSource,
			CLAIM_LEASE_SECONDS: String(claimLeaseSeconds),
			TRACKED_KNOWLEDGE_BASE_IDS: props.knowledgeBaseIds.join(","),
		};
		const claimStatements = [
			new iam.PolicyStatement({
				actions: ["events:PutEvents"],
				resources: [eventBusArn],
			}),
			new iam.PolicyStatement({
				actions: [
					"dynamodb:GetItem",
					"dynamodb:PutItem",
					"dynamodb:UpdateItem",
					"dynamodb:DeleteItem",
				],
				resources: [this.table.tableArn],
			}),
			new iam.PolicyStatement({
				actions: ["states:StartExecution"],
				resources: [this.stateMachine.stateMachineArn],
			}),
		];

		this.startFunction = new lambda.Function(this, "StartFunction", {
			description: "Announces ingestion jobs from their INGESTION_JOB_STARTED log record",
			runtime: lambda.Runtime.PYTHON_3_14,
			handler: "start.handler",
			code,
			memorySize: 128,
			timeout: startTimeout,
			environment,
			logGroup: functionLogGroup(this, "StartFunctionLogs"),
		});
		for (const statement of claimStatements) {
			this.startFunction.addToRolePolicy(statement);
		}

		new logs.SubscriptionFilter(this, "StartedFilter", {
			logGroup,
			filterName: `${props.name}-ingestion-started`,
			filterPattern: logs.FilterPattern.stringValue(
				"$.event.ingestion_job_status",
				"=",
				"INGESTION_JOB_STARTED",
			),
			destination: new logsDestinations.LambdaDestination(this.startFunction),
		});

		this.sweepFunction = new lambda.Function(this, "SweepFunction", {
			description: "Announces ingestion jobs that the log path missed",
			runtime: lambda.Runtime.PYTHON_3_14,
			handler: "sweep.handler",
			code,
			memorySize: 256,
			timeout: sweepTimeout,
			// One run at a time, so runs never overlap.
			reservedConcurrentExecutions: 1,
			environment: {
				...environment,
				SWEEP_EPOCH: props.sweepEpoch,
				SWEEP_RPS: String(sweepRps),
				KNOWLEDGE_BASE_ARN_PREFIX: `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:knowledge-base/`,
			},
			logGroup: functionLogGroup(this, "SweepFunctionLogs"),
		});
		this.sweepFunction.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ["bedrock:ListDataSources", "bedrock:ListIngestionJobs"],
				resources: knowledgeBaseArns,
			}),
		);
		for (const statement of claimStatements) {
			this.sweepFunction.addToRolePolicy(statement);
		}

		if (sweepEnabled) {
			new scheduler.Schedule(this, "SweepSchedule", {
				description: "Runs the ingestion job sweep",
				schedule:
					props.sweepSchedule ?? scheduler.ScheduleExpression.rate(cdk.Duration.minutes(15)),
				target: new schedulerTargets.LambdaInvoke(this.sweepFunction),
			});
		}
	}

	/**
	 * The per-job poller: a Standard state machine in JSONata (it needs date
	 * arithmetic for durationSeconds):
	 *
	 * Init -> IncrementPollCount -> PollCapReached? -> Wait -> GetIngestionJob -> IsTerminal?
	 *            ^-- not terminal, or Catch 1 on a retryable error --------------------'
	 */
	private createPoller(options: {
		name: string;
		knowledgeBaseArns: string[];
		eventBusName: string;
		eventBusArn: string;
		eventSource: string;
		pollIntervalSeconds: number;
		jitterSeconds: number;
	}): sfn.StateMachine {
		// Assigned once from the execution input, which the claim step builds.
		const init = sfn.Pass.jsonata(this, "Init", {
			assign: {
				knowledgeBaseId: "{% $states.input.knowledgeBaseId %}",
				knowledgeBaseArn: "{% $states.input.knowledgeBaseArn %}",
				dataSourceId: "{% $states.input.dataSourceId %}",
				ingestionJobId: "{% $states.input.ingestionJobId %}",
				detectedBy: "{% $states.input.detectedBy %}",
				trigger: "{% $states.input.trigger %}",
				maxPolls: this.maxPolls,
				// Epoch milliseconds after which the poller reports UNKNOWN_TIMEOUT.
				deadlineMillis: `{% $toMillis($states.context.Execution.StartTime) + ${this.maxJobDurationSeconds * 1000} %}`,
				pollIntervalSeconds: options.pollIntervalSeconds,
				jitterSeconds: options.jitterSeconds,
				pollCount: 0,
			},
		});

		// Every path back to Wait passes here, so the deadline and maxPolls
		// bound the loop.
		// The jittered wait is computed here with $random(), so the loop
		// needs no extra state for it.
		const incrementPollCount = sfn.Pass.jsonata(this, "IncrementPollCount", {
			assign: {
				pollCount: "{% $pollCount + 1 %}",
				waitSeconds: "{% $pollIntervalSeconds + $floor($random() * ($jitterSeconds + 1)) %}",
			},
		});

		const wait = sfn.Wait.jsonata(this, "Wait", {
			time: sfn.WaitTime.seconds("{% $waitSeconds %}"),
		});

		// Output is PascalCase: IngestionJob.Status, .StartedAt, ...
		const getIngestionJob = tasks.CallAwsService.jsonata(this, "GetIngestionJob", {
			service: "bedrockagent",
			action: "getIngestionJob",
			iamAction: "bedrock:GetIngestionJob",
			iamResources: options.knowledgeBaseArns,
			parameters: {
				KnowledgeBaseId: "{% $knowledgeBaseId %}",
				DataSourceId: "{% $dataSourceId %}",
				IngestionJobId: "{% $ingestionJobId %}",
			},
		});

		const emit = (id: string, detail: string): sfn.CustomState =>
			new sfn.CustomState(this, id, {
				// A custom state because the CDK EventBridgePutEvents task has
				// no Resources field. The task fails with EventBridge.FailedEntry
				// when an entry fails. One entry per call, so a retry can't
				// repeat another entry.
				stateJson: {
					Type: "Task",
					Resource: `arn:${cdk.Aws.PARTITION}:states:::events:putEvents`,
					Arguments: {
						Entries: [
							{
								Source: options.eventSource,
								DetailType: FINISHED_DETAIL_TYPE,
								EventBusName: options.eventBusName,
								Resources: ["{% $knowledgeBaseArn %}"],
								// One line; the expressions hold no string with spaces.
								Detail: detail.replace(/\s+/g, " "),
							},
						],
					},
					Retry: [
						{
							ErrorEquals: ["States.ALL"],
							IntervalSeconds: 2,
							BackoffRate: 2,
							MaxAttempts: 3,
							JitterStrategy: "FULL",
						},
					],
				},
			});

		const emitFinished = emit("EmitFinished", finishedDetail());
		const emitTimeout = emit("EmitTimeout", unknownDetail("UNKNOWN_TIMEOUT"));
		const emitUnknownError = emit("EmitUnknownError", unknownDetail("UNKNOWN_ERROR"));

		getIngestionJob.addRetry({
			errors: RETRYABLE_ERRORS,
			interval: cdk.Duration.seconds(5),
			backoffRate: 2,
			maxAttempts: 6,
			jitterStrategy: sfn.JitterType.FULL,
		});
		// Retries ran out: the job is probably still running, so keep polling.
		getIngestionJob.addCatch(incrementPollCount, { errors: RETRYABLE_ERRORS });
		// Only non-retryable errors get here (ResourceNotFound, AccessDenied,
		// Validation).
		getIngestionJob.addCatch(emitUnknownError, {
			errors: [sfn.Errors.ALL],
			outputs: "{% $states.errorOutput %}",
		});

		const isTerminal = sfn.Choice.jsonata(this, "IsTerminal")
			.when(
				sfn.Condition.jsonata(
					"{% $states.input.IngestionJob.Status in ['COMPLETE', 'FAILED', 'STOPPED'] %}",
				),
				emitFinished.next(sfn.Succeed.jsonata(this, "Finished")),
			)
			.otherwise(incrementPollCount);

		emitTimeout.next(
			sfn.Fail.jsonata(this, "TimedOut", {
				error: "UnknownTimeout",
				cause: "The job didn't reach a terminal status within maxJobDuration.",
			}),
		);
		emitUnknownError.next(
			sfn.Fail.jsonata(this, "PollFailed", {
				error: "UnknownError",
				cause: "GetIngestionJob returned a non-retryable error.",
			}),
		);

		// The deadline holds the cap to maxJobDuration despite jitter and
		// retries; maxPolls keeps the history within its budget.
		const pollCapReached = sfn.Choice.jsonata(this, "PollCapReached")
			.when(
				sfn.Condition.jsonata(
					"{% $toMillis($now()) >= $deadlineMillis or $pollCount > $maxPolls %}",
				),
				emitTimeout,
			)
			.otherwise(wait.next(getIngestionJob).next(isTerminal));

		const definition = init.next(incrementPollCount).next(pollCapReached);

		const stateMachine = new sfn.StateMachine(this, "Poller", {
			stateMachineType: sfn.StateMachineType.STANDARD,
			queryLanguage: sfn.QueryLanguage.JSONATA,
			definitionBody: sfn.DefinitionBody.fromChainable(definition),
			logs: {
				// /aws/vendedlogs/ avoids a CloudWatch Logs resource policy.
				destination: new logs.LogGroup(this, "PollerLogs", {
					logGroupName: `/aws/vendedlogs/states/${options.name}-poller`,
					retention: logs.RetentionDays.ONE_MONTH,
					removalPolicy: cdk.RemovalPolicy.DESTROY,
				}),
				level: sfn.LogLevel.ALL,
				includeExecutionData: false,
			},
		});
		stateMachine.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ["events:PutEvents"],
				resources: [options.eventBusArn],
			}),
		);
		return stateMachine;
	}
}

function validate(
	props: IngestionObservabilityProps,
	values: {
		pollIntervalSeconds: number;
		jitterSeconds: number;
		sweepRps: number;
		claimLeaseSeconds: number;
		longestTimeout: number;
	},
): void {
	if (props.knowledgeBaseIds.length === 0) {
		throw new Error("knowledgeBaseIds must list at least one knowledge base ID.");
	}
	for (const kbId of props.knowledgeBaseIds) {
		if (!cdk.Token.isUnresolved(kbId) && !KNOWLEDGE_BASE_ID_PATTERN.test(kbId)) {
			throw new Error(
				`Knowledge base ID "${kbId}" must be 10 uppercase letters and digits, such as EXAMPLEKB1.`,
			);
		}
	}
	if (!Number.isInteger(values.pollIntervalSeconds) || values.pollIntervalSeconds < 1) {
		throw new Error(
			`pollIntervalSeconds must be a whole number of at least 1, not ${values.pollIntervalSeconds}.`,
		);
	}
	if (!Number.isInteger(values.jitterSeconds) || values.jitterSeconds < 0) {
		throw new Error(
			`jitterSeconds must be a whole number of at least 0, not ${values.jitterSeconds}.`,
		);
	}
	if (!(values.sweepRps > 0 && values.sweepRps <= 10)) {
		throw new Error(
			`sweepRps must be more than 0 and at most 10, not ${values.sweepRps}.`,
		);
	}
	if (!(values.claimLeaseSeconds > values.longestTimeout)) {
		throw new Error(
			`claimLeaseSeconds ${values.claimLeaseSeconds} must exceed both function timeouts ` +
				`(the longer is ${values.longestTimeout} s), or a live claim could be taken over.`,
		);
	}
	if (Number.isNaN(Date.parse(props.sweepEpoch))) {
		throw new Error(`sweepEpoch must be an ISO 8601 timestamp, not "${props.sweepEpoch}".`);
	}
}

function functionLogGroup(scope: Construct, id: string): logs.LogGroup {
	return new logs.LogGroup(scope, id, {
		retention: logs.RetentionDays.ONE_MONTH,
		removalPolicy: cdk.RemovalPolicy.DESTROY,
	});
}

/** Fields that every Finished event carries, as JSONata object entries. */
const COMMON_FIELDS = `
	"version": "1",
	"knowledgeBaseId": $knowledgeBaseId,
	"knowledgeBaseArn": $knowledgeBaseArn,
	"dataSourceId": $dataSourceId,
	"ingestionJobId": $ingestionJobId,`;

const PROVENANCE_FIELDS = `
	"trigger": $trigger,
	"detectedBy": $detectedBy`;

/**
 * Finished detail from the final GetIngestionJob output. Maps
 * the PascalCase SDK output to camelCase, caps failureReasons at 20 entries
 * of 2,000 characters, and leaves out textReadyAt when the API has none.
 */
function finishedDetail(): string {
	return `{% (
	$job := $states.input.IngestionJob;
	$stats := $job.Statistics;
	$reasons := $exists($job.FailureReasons) ? $job.FailureReasons : [];
	{${COMMON_FIELDS}
	"status": $job.Status,
	"startedAt": $fromMillis($toMillis($job.StartedAt)),
	"updatedAt": $fromMillis($toMillis($job.UpdatedAt)),
	"durationSeconds": $round(($toMillis($job.UpdatedAt) - $toMillis($job.StartedAt)) / 1000),
	"textReadyAt": $job.TextReadyAt,
	"statistics": {
		"numberOfDocumentsScanned": $stats.NumberOfDocumentsScanned,
		"numberOfNewDocumentsIndexed": $stats.NumberOfNewDocumentsIndexed,
		"numberOfModifiedDocumentsIndexed": $stats.NumberOfModifiedDocumentsIndexed,
		"numberOfDocumentsDeleted": $stats.NumberOfDocumentsDeleted,
		"numberOfDocumentsFailed": $stats.NumberOfDocumentsFailed,
		"numberOfDocumentsSkipped": $stats.NumberOfDocumentsSkipped,
		"numberOfMetadataDocumentsScanned": $stats.NumberOfMetadataDocumentsScanned,
		"numberOfMetadataDocumentsModified": $stats.NumberOfMetadataDocumentsModified
	},
	"hasDocumentFailures": $exists($stats.NumberOfDocumentsFailed) and $stats.NumberOfDocumentsFailed > 0,
	"failureReasons": [$map($reasons[[0..19]], function($r) { $substring($r, 0, 2000) })],
	"failureReasonsTruncated": $count($reasons) > 20 or $count($reasons[$length($) > 2000]) > 0,${PROVENANCE_FIELDS}
	}
) %}`;
}

/**
 * Finished detail for UNKNOWN_TIMEOUT and UNKNOWN_ERROR, without the API
 * fields. UNKNOWN_ERROR adds the error name and a truncated cause from the
 * Catch output ($states.errorOutput).
 */
function unknownDetail(status: "UNKNOWN_TIMEOUT" | "UNKNOWN_ERROR"): string {
	const errorFields =
		status === "UNKNOWN_ERROR"
			? `
	"error": $states.input.Error,
	"cause": $substring($states.input.Cause, 0, 2000),`
			: "";
	return `{% {${COMMON_FIELDS}
	"status": "${status}",${errorFields}${PROVENANCE_FIELDS}
} %}`;
}
