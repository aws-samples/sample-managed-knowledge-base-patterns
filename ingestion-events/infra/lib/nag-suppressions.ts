import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { rules } from "cdk-nag";
import { IConstruct } from "constructs";

function acknowledge(scope: IConstruct, id: string, reason: string): void {
	cdk.Validations.of(scope).acknowledge({ id, reason });
}

/** An AwsSolutions-IAM5 finding that is accepted, with the reason it is needed. */
interface AcceptedWildcard {
	/** The finding, such as `Action::s3:List*`, or a pattern for one. */
	readonly finding: RegExp;
	readonly reason: string;
}

/**
 * Acknowledge the AwsSolutions-IAM5 findings (one per wildcard action or
 * resource) of the IAM policies under a scope that match an accepted
 * wildcard. Any other finding stays unacknowledged and fails synthesis, so a
 * wildcard added later is reported instead of waived.
 */
class AcknowledgeWildcardPermissions implements cdk.IAspect {
	constructor(private readonly accepted: AcceptedWildcard[]) {}

	visit(node: IConstruct): void {
		if (!(node instanceof iam.CfnPolicy || node instanceof iam.CfnRole)) {
			return;
		}
		const findings = rules.iam.IAMNoWildcardPermissions(node);
		if (!Array.isArray(findings)) {
			return;
		}
		for (const finding of findings) {
			const reason = this.accepted.find(({ finding: pattern }) =>
				pattern.test(finding),
			)?.reason;
			if (reason) {
				acknowledge(node, `AwsSolutions-IAM5[${finding}]`, reason);
			}
		}
	}
}

function acknowledgeWildcards(
	scope: IConstruct,
	accepted: AcceptedWildcard[],
): void {
	cdk.Aspects.of(scope).add(new AcknowledgeWildcardPermissions(accepted), {
		priority: cdk.AspectPriority.READONLY,
	});
}

/**
 * The CDK asset bucket, such as `cdk-hnb659fds-assets-<account>-<region>`.
 * Without an account at synth time, as in CI, the account is the
 * `<AWS::AccountId>` pseudo parameter, and the partition and Region can be
 * pseudo parameters too, so match any characters but `/`.
 */
const CDK_ASSETS_OBJECTS =
	/^Resource::arn:(?:[^:]+|<AWS::Partition>):s3:::cdk-[a-z0-9]+-assets-[^/]+\/\*$/;

/**
 * Acknowledge the cdk-nag findings that are accepted for this sample. Each
 * reason states what to change before using the code in production.
 */
export function addNagSuppressions(stack: cdk.Stack): void {
	acknowledge(
		stack,
		"AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
		"The Start and Sweep functions and the AWS CDK handler functions use the AWS managed policy that only grants writing CloudWatch logs. For production, replace it with a policy scoped to each function's own log group.",
	);

	const ingestionEvents = stack.node.findChild("IngestionEvents");
	const poller = ingestionEvents.node.findChild("Poller");
	acknowledgeWildcards(poller, [
		{
			finding: /^Resource::\*$/,
			reason:
				"Step Functions logging to CloudWatch Logs needs the log delivery actions (logs:CreateLogDelivery and others) on all resources; they don't support resource-level permissions. AWS CDK adds them for the state machine's logging configuration.",
		},
	]);
	acknowledge(
		poller,
		"AwsSolutions-SF2",
		"X-Ray tracing is off in the sample to keep its cost at zero. For production, set tracingEnabled on the state machine if you trace requests end to end.",
	);

	// EventBridge Scheduler's role for the sweep target is a child of the
	// stack, named after a hash of the target.
	for (const child of stack.node.children) {
		if (child.node.id.startsWith("SchedulerRoleForTarget-")) {
			acknowledgeWildcards(child, [
				{
					finding: /^Resource::<IngestionEventsSweepFunction[0-9A-F]{8}\.Arn>:\*$/,
					reason:
						"AWS CDK lets the scheduler invoke any version or alias of the Sweep function, which has none. For production, keep it or scope the role to the function ARN only.",
				},
			]);
		}
	}

	// Only with the demo knowledge base.
	if (!stack.node.tryFindChild("DemoBucket")) {
		return;
	}

	// The BucketDeployment provider is a child of the stack, not of the
	// construct that uses it, and its ID includes the memory size.
	for (const child of stack.node.children) {
		if (child.node.id.startsWith("Custom::CDKBucketDeployment")) {
			const copyReason =
				"The CDK BucketDeployment handler copies the demo files from the asset bucket to the demo bucket. For production, load documents through your own pipeline.";
			acknowledgeWildcards(child, [
				{
					finding:
						/^Action::s3:(GetObject|GetBucket|List|DeleteObject|Abort)\*$/,
					reason: copyReason,
				},
				{ finding: CDK_ASSETS_OBJECTS, reason: copyReason },
				{
					finding: /^Resource::<DemoBucket[0-9A-F]{8}\.Arn>\/\*$/,
					reason: copyReason,
				},
			]);
			acknowledge(
				child,
				"AwsSolutions-L1",
				"The CDK BucketDeployment handler runtime is managed by AWS CDK. For production, keep AWS CDK up to date.",
			);
		}
	}

	acknowledge(
		stack.node.findChild("DemoBucket"),
		"AwsSolutions-S1",
		"The demo bucket holds fictitious sample runbooks. For production data, enable server access logging.",
	);

	acknowledgeWildcards(stack.node.findChild("DemoKnowledgeBaseRole"), [
		{
			finding: /^Resource::<DemoBucket[0-9A-F]{8}\.Arn>\/\*$/,
			reason:
				"The demo knowledge base role reads every object in the bucket that holds only the demo files. For production, limit it to the data source's inclusion prefixes.",
		},
	]);
}
