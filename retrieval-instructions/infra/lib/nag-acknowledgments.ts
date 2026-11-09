import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { rules } from 'cdk-nag';
import { IConstruct } from 'constructs';

// cdk-nag v3 reads acknowledgments made with `Validations.of(scope).acknowledge`, and
// an acknowledgment covers its scope and everything below it. Each one here is made on
// the narrowest construct that has the finding.
//
// Every pattern matches literal ARNs only. They rely on
// @aws-cdk/core:enablePartitionLiterals (infra/cdk.json), a Region that aws-cdk-lib
// knows, and a concrete account. With an unknown Region or a token account, cdk-nag
// renders <AWS::Partition> or <AWS::AccountId>, nothing here matches, and synth fails
// instead of waiving the finding.

function acknowledge(scope: IConstruct, id: string, reason: string): void {
  cdk.Validations.of(scope).acknowledge({ id, reason });
}

/** A wildcard that is accepted, with the reason it is needed. */
interface AcceptedWildcard {
  /** The AwsSolutions-IAM5 finding, such as `Action::s3:List*`, or a pattern for it. */
  readonly finding: string | RegExp;
  readonly reason: string;
}

/**
 * Actions accepted on `"Resource": "*"`. One `Resource::*` finding covers every such
 * statement of a policy, so the actions are checked instead.
 */
interface AcceptedAnyResource {
  readonly actions: readonly string[];
  readonly reason: string;
}

export interface AcceptedWildcards {
  readonly wildcards?: readonly AcceptedWildcard[];
  readonly anyResource?: AcceptedAnyResource;
}

interface StatementJson {
  readonly Effect?: string;
  readonly Action?: string | string[];
  readonly Resource?: unknown;
}

/** The resolved statements of an IAM policy, or of a role's inline policies. */
function statementsOf(node: iam.CfnPolicy | iam.CfnRole): StatementJson[] {
  const stack = cdk.Stack.of(node);
  const documents: { Statement?: StatementJson[] }[] =
    node instanceof iam.CfnPolicy
      ? [stack.resolve(node.policyDocument)]
      : ((stack.resolve(node.policies) ?? []) as { policyDocument: object }[]).map(
          (policy) => stack.resolve(policy.policyDocument),
        );
  return documents.flatMap((document) => document.Statement ?? []);
}

/** The actions that Allow statements of a policy grant on every resource. */
function actionsOnAnyResource(node: iam.CfnPolicy | iam.CfnRole): string[] {
  return statementsOf(node)
    .filter((statement) => statement.Effect === 'Allow')
    .filter((statement) => ([] as unknown[]).concat(statement.Resource).includes('*'))
    .flatMap((statement) => ([] as string[]).concat(statement.Action ?? []));
}

/**
 * Acknowledges the AwsSolutions-IAM5 findings of the policies under a scope that match
 * an accepted wildcard. cdk-nag's own rule computes the findings, so the IDs are exact.
 * Any other finding stays unacknowledged and fails synth, so a wildcard added later is
 * reported instead of waived. Runs as a read-only aspect, after every grant is added.
 */
class AcknowledgeWildcardPermissions implements cdk.IAspect {
  constructor(private readonly accepted: AcceptedWildcards) {}

  visit(node: IConstruct): void {
    if (!(node instanceof iam.CfnPolicy || node instanceof iam.CfnRole)) {
      return;
    }
    const findings = rules.iam.IAMNoWildcardPermissions(node);
    if (!Array.isArray(findings)) {
      return;
    }
    for (const finding of findings) {
      const reason = this.reasonFor(node, finding);
      if (reason) {
        acknowledge(node, `AwsSolutions-IAM5[${finding}]`, reason);
      }
    }
  }

  private reasonFor(
    node: iam.CfnPolicy | iam.CfnRole,
    finding: string,
  ): string | undefined {
    if (finding === 'Resource::*') {
      const accepted = this.accepted.anyResource;
      if (!accepted) {
        return undefined;
      }
      const granted = actionsOnAnyResource(node);
      return granted.every((action) => accepted.actions.includes(action))
        ? accepted.reason
        : undefined;
    }
    return this.accepted.wildcards?.find(({ finding: pattern }) =>
      typeof pattern === 'string' ? pattern === finding : pattern.test(finding),
    )?.reason;
  }
}

export function acknowledgeWildcards(
  scope: IConstruct,
  accepted: AcceptedWildcards,
): void {
  cdk.Aspects.of(scope).add(new AcknowledgeWildcardPermissions(accepted), {
    priority: cdk.AspectPriority.READONLY,
  });
}

/** `arn:<partition>:bedrock:<region>:<account>:retrieval-instruction/*`, literal only. */
const RETRIEVAL_INSTRUCTIONS =
  /^Resource::arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d{12}:retrieval-instruction\/\*$/;

/** Accepted wildcards of the tenant and platform admin roles. */
export const INSTRUCTIONS_BY_TAG: AcceptedWildcard = {
  finding: RETRIEVAL_INSTRUCTIONS,
  reason:
    "Instructions are created after deployment, so their IDs aren't known. Every " +
    'statement on this resource has an aws:ResourceTag or aws:RequestTag condition.',
};

export const LIST_INSTRUCTIONS: AcceptedAnyResource = {
  actions: ['bedrock:ListRetrievalInstructions'],
  reason: "ListRetrievalInstructions can't be scoped to a resource or a tag.",
};

export const AGENTIC_RETRIEVE_STREAM: AcceptedAnyResource = {
  actions: ['bedrock:AgenticRetrieveStream'],
  reason:
    "bedrock:AgenticRetrieveStream doesn't support resource-level permissions. Its " +
    "internal retrieval is authorized as bedrock:Retrieve, which this role scopes to the tenant's knowledge bases.",
};

/** `Resource::<CorpusBucketXXXXXXXX.Arn>/<suffix>`, for the stack's corpus bucket. */
function corpusObjects(suffix: string): RegExp {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`^Resource::<CorpusBucket[0-9A-F]{8}\\.Arn>\\/${escaped}$`);
}

/** Acknowledges the object wildcards of a knowledge base service role. */
export function acknowledgeServiceRole(
  role: IConstruct,
  readPrefixes: readonly string[],
): void {
  const where = readPrefixes.join(' and ');
  const reason =
    `The data source crawls every object under ${where}, so object keys aren't known ` +
    'when the policy is written. One action (s3:GetObject), one stack-owned bucket, ' +
    'aws:ResourceAccount condition.';
  acknowledgeWildcards(role, {
    wildcards: readPrefixes.map((prefix) => ({
      finding: corpusObjects(`${prefix}*`),
      reason,
    })),
  });
}

/** The CDK assets bucket objects, `cdk-<qualifier>-assets-<account>-<region>/*`. */
const CDK_ASSETS_OBJECTS =
  /^Resource::arn:aws[a-z-]*:s3:::cdk-[a-z0-9]+-assets-\d{12}-[a-z0-9-]+\/\*$/;

/** Stack-wide acknowledgments: the corpus bucket and the CDK provider functions. */
export function acknowledgeStackFindings(
  stack: cdk.Stack,
  corpusBucket: s3.IBucket,
): void {
  acknowledge(
    corpusBucket,
    'AwsSolutions-S1',
    'The bucket holds the fictitious sample corpus and is deleted with the stack. ' +
      'Enable server access logging for real documents.',
  );
  for (const child of stack.node.children) {
    const id = child.node.id;
    const isBucketDeployment = id.startsWith('Custom::CDKBucketDeployment');
    const isAwsCustomResource = id.startsWith('AWS679f53fac002430cb0da5b7982bd2287');
    if (!isBucketDeployment && !isAwsCustomResource) {
      continue;
    }
    acknowledge(
      child,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      "CDK's custom resource handlers use the AWS managed policy that only grants writing their own logs.",
    );
    if (isBucketDeployment) {
      const reason =
        'The CDK BucketDeployment handler copies the corpus from the CDK assets bucket ' +
        'and deletes it on stack deletion.';
      acknowledgeWildcards(child, {
        wildcards: [
          {
            finding: /^Action::s3:(GetObject|GetBucket|List|DeleteObject|Abort)\*$/,
            reason,
          },
          { finding: CDK_ASSETS_OBJECTS, reason },
          { finding: corpusObjects('*'), reason },
        ],
      });
      acknowledge(
        child,
        'AwsSolutions-L1',
        'The handler runtime is managed by AWS CDK.',
      );
    }
  }
}
