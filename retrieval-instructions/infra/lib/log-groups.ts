import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

// Log groups for the Lambda functions that AWS CDK adds for its own custom resources.
// Without them, each function creates /aws/lambda/<name> on first use, outside the
// stack, and `cdk destroy` leaves it behind. A function that logs through
// LoggingConfig depends on its log group, so CloudFormation deletes the log group
// only after the function.

/** Log group for the `BucketDeployment` handler. */
export function bucketDeploymentLogGroup(scope: Construct): logs.ILogGroup {
  return stackLogGroup(scope, 'BucketDeploymentLogs');
}

/** Log group for every `AwsCustomResource`, which share one handler function. */
export function awsCustomResourceLogGroup(scope: Construct): logs.ILogGroup {
  return stackLogGroup(scope, 'AwsCustomResourceLogs');
}

/**
 * The handler that `autoDeleteObjects` adds is a plain CloudFormation function: CDK has
 * no log group option for it, and `Tags.of` doesn't reach it or its role. Send its logs
 * to a stack log group, and give the function and its role these tags. Call this after
 * the bucket exists.
 */
export function configureAutoDeleteObjectsHandler(
  stack: cdk.Stack,
  tags: Record<string, string>,
): void {
  const provider = stack.node.tryFindChild(
    'Custom::S3AutoDeleteObjectsCustomResourceProvider',
  );
  const role = provider?.node.tryFindChild('Role');
  const handler = provider?.node.tryFindChild('Handler');
  if (!(role instanceof cdk.CfnResource) || !(handler instanceof cdk.CfnResource)) {
    throw new Error(
      'The S3 auto-delete handler was not found. Check its construct IDs after upgrading AWS CDK.',
    );
  }
  const logGroup = stackLogGroup(stack, 'AutoDeleteObjectsLogs');
  handler.addPropertyOverride('LoggingConfig.LogGroup', logGroup.logGroupName);
  const tagList = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
  role.addPropertyOverride('Tags', tagList);
  handler.addPropertyOverride('Tags', tagList);
}

/** Return the stack's log group with this ID, creating it on first use. */
function stackLogGroup(scope: Construct, id: string): logs.ILogGroup {
  const stack = cdk.Stack.of(scope);
  const existing = stack.node.tryFindChild(id);
  if (existing instanceof logs.LogGroup) {
    return existing;
  }
  return new logs.LogGroup(stack, id, {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}

/**
 * Make every IAM role depend on every log group, so CloudFormation deletes the log
 * groups only after the roles. Custom resources run while the stack is deleted, and
 * Lambda delivers their log events seconds later. Once the function's role is gone, a
 * late event can't create the log group again. Call this last, after every role
 * exists.
 */
export function deleteLogGroupsAfterRoles(stack: cdk.Stack): void {
  const resources = stack.node
    .findAll()
    .filter((node): node is cdk.CfnResource => node instanceof cdk.CfnResource);
  const logGroups = resources.filter(
    (resource) => resource.cfnResourceType === 'AWS::Logs::LogGroup',
  );
  const roles = resources.filter(
    (resource) => resource.cfnResourceType === 'AWS::IAM::Role',
  );
  for (const role of roles) {
    for (const logGroup of logGroups) {
      role.addResourceDependency(logGroup);
    }
  }
}
