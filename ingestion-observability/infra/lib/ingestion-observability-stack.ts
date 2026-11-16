import * as cdk from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { IngestionObservability, IngestionObservabilityProps } from "./ingestion-observability";
import {
	addAutoDeleteObjectsLogGroup,
	bucketDeploymentLogGroup,
	deleteLogGroupsAfterRoles,
} from "./log-groups";
import { addNagSuppressions } from "./nag-suppressions";

export interface IngestionObservabilityStackProps
	extends cdk.StackProps,
		Omit<IngestionObservabilityProps, "name" | "knowledgeBaseIds"> {
	/**
	 * Prefix of the resource names. Lowercase letters, numbers, and single
	 * hyphens, 2 to 32 characters.
	 */
	readonly name: string;
	/**
	 * Deploy a small demo knowledge base with an S3 data source, tracked
	 * ahead of `knowledgeBaseIds`, so the pattern can be tried without one.
	 */
	readonly deployDemo: boolean;
	/** Local folder of the demo documents. */
	readonly dataDir: string;
	/** Existing knowledge bases to track. */
	readonly knowledgeBaseIds: string[];
	/**
	 * Write every event with the pattern's source to a log group of the
	 * stack, so you can read the events while you try the pattern.
	 *
	 * @default true
	 */
	readonly captureEvents?: boolean;
	/**
	 * Day of the week, such as MONDAY, for a weekly scheduled sync of the
	 * demo data source.
	 *
	 * @default no schedule
	 */
	readonly demoSyncDay?: string;
}

/** Lowercase for S3 and no doubled hyphens for knowledge base names. */
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The demo data source reads only this prefix. */
export const DOCUMENT_PREFIX = "docs/";

/** Local files that must not be uploaded, such as .DS_Store. */
const LOCAL_ARTIFACTS = [".*", "__pycache__"];

/** A rule target that sends events to a log group whose resource policy the stack owns. */
class LogGroupTarget implements events.IRuleTarget {
	constructor(private readonly arn: string) {}

	bind(): events.RuleTargetConfig {
		return { arn: this.arn };
	}
}

/**
 * The ingestion-observability pattern: the IngestionObservability construct,
 * an optional demo knowledge base, and an optional capture of the events.
 */
export class IngestionObservabilityStack extends cdk.Stack {
	readonly observability: IngestionObservability;

	constructor(scope: Construct, id: string, props: IngestionObservabilityStackProps) {
		super(scope, id, props);

		if (
			!(props.name.length >= 2 && props.name.length <= 32) ||
			!NAME_PATTERN.test(props.name)
		) {
			throw new Error(
				`name "${props.name}" must be 2 to 32 lowercase letters, numbers, and single hyphens.`,
			);
		}
		if (!props.deployDemo && props.knowledgeBaseIds.length === 0) {
			throw new Error(
				"Set knowledgeBaseIds to the knowledge bases to track, or deploy the demo knowledge base.",
			);
		}
		if (props.deployDemo && props.existingLogGroupName) {
			throw new Error(
				"existingLogGroupName creates no log delivery, so the demo knowledge base would deliver nothing. " +
					"Deploy existing-log-group mode in a stack without the demo.",
			);
		}

		cdk.Tags.of(this).add("project", "ingestion-observability-sample");

		const outputs: Record<string, string> = {};
		const knowledgeBaseIds = [...props.knowledgeBaseIds];
		if (props.deployDemo) {
			const demo = this.createDemo(props);
			knowledgeBaseIds.unshift(demo.knowledgeBase.attrKnowledgeBaseId);
			Object.assign(outputs, {
				DemoKnowledgeBaseId: demo.knowledgeBase.attrKnowledgeBaseId,
				DemoDataSourceId: demo.dataSource.attrDataSourceId,
				DemoKnowledgeBaseRoleName: demo.role.roleName,
				BucketName: demo.bucket.bucketName,
			});
		}

		this.observability = new IngestionObservability(this, "IngestionObservability", {
			...props,
			knowledgeBaseIds,
		});

		const eventSource = props.eventSource ?? "custom.bedrock.kb-ingestion";
		const eventBusName = props.eventBusName ?? "default";
		if (props.captureEvents ?? true) {
			const eventLogGroupName = `/ingestion-observability/${props.name}/events`;
			const eventLogs = new logs.LogGroup(this, "EventLogs", {
				logGroupName: eventLogGroupName,
				retention: logs.RetentionDays.ONE_MONTH,
				removalPolicy: cdk.RemovalPolicy.DESTROY,
			});
			// The events-targets CloudWatchLogGroup target would manage this
			// policy with a custom resource whose log group is retained for
			// two years, so the stack owns the policy instead.
			const policy = new logs.ResourcePolicy(this, "EventLogsPolicy", {
				resourcePolicyName: `ingestion-observability-${props.name}-events`,
				policyStatements: [
					new iam.PolicyStatement({
						principals: [
							new iam.ServicePrincipal("events.amazonaws.com"),
							new iam.ServicePrincipal("delivery.logs.amazonaws.com"),
						],
						actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
						resources: [eventLogs.logGroupArn],
					}),
				],
			});
			const rule = new events.Rule(this, "CaptureEvents", {
				description: `Writes every ${eventSource} event to ${eventLogGroupName}`,
				eventBus: events.EventBus.fromEventBusName(this, "EventBus", eventBusName),
				eventPattern: { source: [eventSource] },
				targets: [
					new LogGroupTarget(
						this.formatArn({
							service: "logs",
							resource: "log-group",
							arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
							resourceName: eventLogGroupName,
						}),
					),
				],
			});
			// The rule delivers only once the log group accepts its events.
			rule.node.addDependency(policy);
			outputs.EventLogGroup = eventLogs.logGroupName;
		}

		Object.assign(outputs, {
			IngestionLogGroup: this.observability.logGroupName,
			StateMachineArn: this.observability.stateMachine.stateMachineArn,
			ClaimTableName: this.observability.table.tableName,
			StartFunctionName: this.observability.startFunction.functionName,
			SweepFunctionName: this.observability.sweepFunction.functionName,
			FailedExecutionsAlarmName: this.observability.alarm.alarmName,
		});
		for (const [outputName, value] of Object.entries(outputs)) {
			new cdk.CfnOutput(this, outputName, { value });
		}

		if (props.deployDemo) {
			addAutoDeleteObjectsLogGroup(this);
		}
		deleteLogGroupsAfterRoles(this);
		addNagSuppressions(this);
	}

	/** A managed knowledge base over an S3 bucket of the sample runbooks. */
	private createDemo(props: IngestionObservabilityStackProps): {
		bucket: s3.Bucket;
		role: iam.Role;
		knowledgeBase: bedrock.CfnKnowledgeBase;
		dataSource: bedrock.CfnDataSource;
	} {
		const bucket = new s3.Bucket(this, "DemoBucket", {
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
			encryption: s3.BucketEncryption.S3_MANAGED,
			bucketKeyEnabled: true,
			enforceSSL: true,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});
		const documents = new s3deploy.BucketDeployment(this, "DemoDocuments", {
			sources: [s3deploy.Source.asset(props.dataDir, { exclude: LOCAL_ARTIFACTS })],
			destinationBucket: bucket,
			destinationKeyPrefix: DOCUMENT_PREFIX,
			// 512 MB is enough to copy the small demo files.
			memoryLimit: 512,
			logGroup: bucketDeploymentLogGroup(this),
		});

		const sameAccount = { StringEquals: { "aws:ResourceAccount": this.account } };
		const role = new iam.Role(this, "DemoKnowledgeBaseRole", {
			description: "Lets Amazon Bedrock read the ingestion-observability demo files",
			assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
				conditions: {
					StringEquals: { "aws:SourceAccount": this.account },
					ArnLike: {
						"aws:SourceArn": this.formatArn({
							service: "bedrock",
							resource: "knowledge-base",
							resourceName: "*",
						}),
					},
				},
			}),
			inlinePolicies: {
				[`${props.name}-demo-kb-s3-read`]: new iam.PolicyDocument({
					statements: [
						new iam.PolicyStatement({
							sid: "ListBucket",
							actions: ["s3:ListBucket"],
							resources: [bucket.bucketArn],
							conditions: sameAccount,
						}),
						new iam.PolicyStatement({
							sid: "ReadObjects",
							actions: ["s3:GetObject"],
							resources: [bucket.arnForObjects("*")],
							conditions: sameAccount,
						}),
					],
				}),
			},
		});

		const knowledgeBase = new bedrock.CfnKnowledgeBase(this, "DemoKnowledgeBase", {
			name: `${props.name}-demo-kb`,
			description: "ingestion-observability demo: sample runbooks",
			roleArn: role.roleArn,
			knowledgeBaseConfiguration: {
				type: "MANAGED",
				managedKnowledgeBaseConfiguration: { embeddingModelType: "MANAGED" },
			},
		});

		const dataSource = new bedrock.CfnDataSource(this, "DemoDataSource", {
			knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
			name: `${props.name}-demo-s3`,
			description: `ingestion-observability demo: S3 files under ${DOCUMENT_PREFIX}`,
			// Remove the indexed content with the data source, so cdk destroy
			// leaves nothing behind.
			dataDeletionPolicy: "DELETE",
			dataSourceConfiguration: {
				type: "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
				managedKnowledgeBaseConnectorConfiguration: {
					deletionProtectionConfiguration: { deletionProtectionStatus: "DISABLED" },
					syncSchedule: props.demoSyncDay
						? { weekly: { dayOfWeek: props.demoSyncDay } }
						: undefined,
					connectorParameters: {
						type: "S3",
						version: "1",
						connectionConfiguration: {
							bucketName: bucket.bucketName,
							bucketOwnerAccountId: this.account,
						},
						filterConfiguration: { inclusionPrefixes: [DOCUMENT_PREFIX] },
						aclEnabled: false,
					},
				},
			},
		});
		// Bedrock checks that it can read the bucket when the data source is
		// created, so the role's policy and the files come first.
		dataSource.node.addDependency(role, documents);

		return { bucket, role, knowledgeBase, dataSource };
	}
}
