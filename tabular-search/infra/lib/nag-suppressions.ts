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
		"The AWS CDK handler functions use the AWS managed policy that only grants writing their own CloudWatch logs.",
	);

	// The BucketDeployment provider is a child of the stack, not of the
	// construct that uses it, and its ID includes the memory size.
	for (const child of stack.node.children) {
		if (child.node.id.startsWith("Custom::CDKBucketDeployment")) {
			const copyReason =
				"The CDK BucketDeployment handler copies the sample files from the asset bucket to the documents bucket.";
			acknowledgeWildcards(child, [
				{
					finding:
						/^Action::s3:(GetObject|GetBucket|List|DeleteObject|Abort)\*$/,
					reason: copyReason,
				},
				{ finding: CDK_ASSETS_OBJECTS, reason: copyReason },
				{
					finding: /^Resource::<DocumentsBucket[0-9A-F]{8}\.Arn>\/\*$/,
					reason: copyReason,
				},
			]);
			acknowledge(
				child,
				"AwsSolutions-L1",
				"The CDK BucketDeployment handler runtime is managed by AWS CDK.",
			);
		}
	}

	const bucket = stack.node.findChild("DocumentsBucket");
	acknowledge(
		bucket,
		"AwsSolutions-S1",
		"The bucket holds fictitious sample files. Enable server access logging for production data.",
	);

	acknowledgeWildcards(stack.node.findChild("KnowledgeBaseRole"), [
		{
			finding: /^Resource::arn:aws:s3:::<DocumentsBucket[0-9A-F]{8}>\/\*$/,
			reason:
				"The knowledge base role reads every object in the bucket that holds only the sample files, as iam/knowledge-base-s3-read-policy.json shows.",
		},
	]);
}
