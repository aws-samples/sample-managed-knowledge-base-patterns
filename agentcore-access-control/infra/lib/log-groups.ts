import * as cdk from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

// Log groups for the Lambda functions that AWS CDK adds for its own custom
// resources. Without them, these functions create /aws/lambda/<name> on first
// use, outside the stack, and `cdk destroy` leaves it behind. A function that
// logs through LoggingConfig depends on its log group, so CloudFormation
// deletes the log group only after the function.

/** Log group for every `BucketDeployment`, which share one handler function. */
export function bucketDeploymentLogGroup(scope: Construct): logs.ILogGroup {
	return sharedLogGroup(scope, "BucketDeploymentLogs");
}

/** Log group for every `AwsCustomResource`, which share one handler function. */
export function awsCustomResourceLogGroup(scope: Construct): logs.ILogGroup {
	return sharedLogGroup(scope, "AwsCustomResourceLogs");
}

/** Return the log group with this ID in the stack, creating it on first use. */
function sharedLogGroup(scope: Construct, id: string): logs.ILogGroup {
	const stack = cdk.Stack.of(scope);
	const existing = stack.node.tryFindChild(id);
	if (existing) {
		return existing as logs.LogGroup;
	}
	return new logs.LogGroup(stack, id, {
		retention: logs.RetentionDays.ONE_MONTH,
		removalPolicy: cdk.RemovalPolicy.DESTROY,
	});
}

/**
 * Send the logs of the handler that `autoDeleteObjects` adds to a log group of
 * the stack. CDK has no option for this handler, so set LoggingConfig on its
 * function directly. Call this after every bucket of the stack is created.
 */
export function addAutoDeleteObjectsLogGroup(stack: cdk.Stack): void {
	const handler = stack.node
		.tryFindChild("Custom::S3AutoDeleteObjectsCustomResourceProvider")
		?.node.tryFindChild("Handler");
	if (!(handler instanceof cdk.CfnResource)) {
		throw new Error(
			"S3 auto-delete handler not found. Check its construct ID after upgrading AWS CDK.",
		);
	}
	const logGroup = new logs.LogGroup(stack, "AutoDeleteObjectsLogs", {
		retention: logs.RetentionDays.ONE_MONTH,
		removalPolicy: cdk.RemovalPolicy.DESTROY,
	});
	handler.addPropertyOverride("LoggingConfig.LogGroup", logGroup.logGroupName);
}
