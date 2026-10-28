import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { rules } from "cdk-nag";
import { IConstruct } from "constructs";
import { AgentRuntime } from "./constructs/agent-runtime";
import { BypassSimulation } from "./constructs/bypass-simulation";
import { FrontendHosting } from "./constructs/frontend-hosting";
import { Identity } from "./constructs/identity";
import { KbMcpGateway } from "./constructs/kb-mcp-gateway";
import { KnowledgeBase } from "./constructs/knowledge-base";

export interface NagScope {
	readonly hosting: FrontendHosting;
	readonly identity: Identity;
	readonly knowledgeBase: KnowledgeBase;
	readonly gateway: KbMcpGateway;
	readonly agent: AgentRuntime;
	readonly simulation?: BypassSimulation;
}

function acknowledge(scope: IConstruct, id: string, reason: string): void {
	cdk.Validations.of(scope).acknowledge({ id, reason });
}

/** A wildcard permission that is accepted, with the reason it is needed. */
interface AcceptedWildcard {
	/**
	 * The AwsSolutions-IAM5 finding, such as `Action::s3:List*`. Regular
	 * expressions match ARNs that contain the account, Region, or a logical ID.
	 */
	readonly finding: string | RegExp;
	readonly reason: string;
}

/**
 * Actions that are accepted on every resource (`"Resource": "*"`). One
 * `Resource::*` finding covers all such statements of a policy, so the
 * actions are checked statement by statement instead.
 */
interface AcceptedAnyResource {
	readonly actions: string[];
	readonly reason: string;
}

interface AcceptedWildcards {
	readonly wildcards?: AcceptedWildcard[];
	readonly anyResource?: AcceptedAnyResource;
}

interface PolicyStatementJson {
	readonly Action?: string | string[];
	readonly Resource?: unknown;
}

/** Return the resolved statements of an IAM policy or of a role's inline policies. */
function statementsOf(
	node: iam.CfnPolicy | iam.CfnRole,
): PolicyStatementJson[] {
	const stack = cdk.Stack.of(node);
	const documents: { Statement?: PolicyStatementJson[] }[] =
		node instanceof iam.CfnPolicy
			? [stack.resolve(node.policyDocument)]
			: (
					(stack.resolve(node.policies) ?? []) as { policyDocument: object }[]
				).map((policy) => stack.resolve(policy.policyDocument));
	return documents.flatMap((document) => document.Statement ?? []);
}

/** Return the actions that a policy grants on every resource. */
function actionsOnAnyResource(node: iam.CfnPolicy | iam.CfnRole): string[] {
	return statementsOf(node)
		.filter((statement) =>
			([] as unknown[]).concat(statement.Resource).includes("*"),
		)
		.flatMap((statement) => ([] as string[]).concat(statement.Action ?? []));
}

/**
 * Acknowledge the AwsSolutions-IAM5 findings (one per wildcard action or
 * resource) of the IAM policies under a scope that match an accepted
 * wildcard. Any other finding stays unacknowledged and fails synthesis, so a
 * wildcard added later is reported instead of waived. Runs as a read-only
 * aspect, after constructs such as the runtime have added their lazy grants.
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
		if (finding === "Resource::*") {
			const anyResource = this.accepted.anyResource;
			const accepted = anyResource?.actions ?? [];
			const granted = actionsOnAnyResource(node);
			return granted.every((action) => accepted.includes(action))
				? anyResource?.reason
				: undefined;
		}
		return this.accepted.wildcards?.find(({ finding: pattern }) =>
			typeof pattern === "string" ? pattern === finding : pattern.test(finding),
		)?.reason;
	}
}

function acknowledgeWildcards(
	scope: IConstruct,
	accepted: AcceptedWildcards,
): void {
	cdk.Aspects.of(scope).add(new AcknowledgeWildcardPermissions(accepted), {
		priority: cdk.AspectPriority.READONLY,
	});
}

/** The CDK asset bucket, such as `cdk-hnb659fds-assets-<account>-<region>`. */
const CDK_ASSETS_OBJECTS =
	/^Resource::arn:[^:]+:s3:::cdk-[a-z0-9]+-assets-[^:/]+\/\*$/;

/**
 * Acknowledge the cdk-nag findings that are accepted for this sample. Each
 * reason states what to change before using the code in production.
 */
export function addNagSuppressions(stack: cdk.Stack, scope: NagScope): void {
	acknowledge(
		stack,
		"AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
		"Lambda functions use the AWS managed policy that only grants writing their own CloudWatch logs.",
	);

	// CDK provider functions created as children of the stack.
	for (const child of stack.node.children) {
		if (child.node.id.startsWith("Custom::CDKBucketDeployment")) {
			const copyReason =
				"The CDK BucketDeployment handler copies objects between the asset bucket and the destination buckets.";
			acknowledgeWildcards(child, {
				wildcards: [
					{
						finding:
							/^Action::s3:(GetObject|GetBucket|List|DeleteObject|Abort)\*$/,
						reason: copyReason,
					},
					{ finding: CDK_ASSETS_OBJECTS, reason: copyReason },
					{
						finding:
							/^Resource::<(FrontendBucket|KnowledgeBaseDocumentsBucket)[0-9A-F]{8}\.Arn>\/\*$/,
						reason: copyReason,
					},
				],
				anyResource: {
					actions: [
						"cloudfront:GetInvalidation",
						"cloudfront:CreateInvalidation",
					],
					reason:
						"The CDK BucketDeployment handler invalidates the distribution after the copy.",
				},
			});
			acknowledge(
				child,
				"AwsSolutions-L1",
				"The CDK BucketDeployment handler runtime is managed by AWS CDK.",
			);
		}
	}

	for (const bucket of [scope.hosting.bucket, scope.knowledgeBase.bucket]) {
		acknowledge(
			bucket,
			"AwsSolutions-S1",
			"Sample buckets hold static web assets and fictitious documents. Enable server access logging for production data.",
		);
	}

	const distribution = scope.hosting.distribution;
	acknowledge(
		distribution,
		"AwsSolutions-CFR1",
		"The demo app has no geographic restrictions. Add them if your users are in known countries.",
	);
	acknowledge(
		distribution,
		"AwsSolutions-CFR2",
		"AWS WAF is omitted to keep the sample low cost. Associate a web ACL for production.",
	);
	acknowledge(
		distribution,
		"AwsSolutions-CFR3",
		"Access logging is omitted for the demo. Enable standard logging for production.",
	);
	acknowledge(
		distribution,
		"AwsSolutions-CFR4",
		"The sample uses the default CloudFront domain and certificate. Use a custom domain with TLSv1.2_2021 for production.",
	);

	acknowledge(
		scope.identity.userPool,
		"AwsSolutions-COG2",
		"Demo users sign in with a generated password. Require MFA for real users.",
	);
	acknowledge(
		scope.identity.userPool,
		"AwsSolutions-COG8",
		"The Essentials feature plan supports access token customization. The Plus plan adds threat protection for production.",
	);
	acknowledge(
		scope.identity.demoUserPassword,
		"AwsSolutions-SMG4",
		"The secret holds the password of the two demo users. Delete the stack after testing.",
	);

	acknowledgeWildcards(scope.knowledgeBase, {
		wildcards: [
			{
				finding:
					/^Resource::<KnowledgeBaseDocumentsBucket[0-9A-F]{8}\.Arn>\/documents\/\*$/,
				reason:
					"The knowledge base service role reads every object under the documents/ prefix.",
			},
		],
		anyResource: {
			actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
			reason:
				"The service selects the managed embedding and reranking models, so their ARNs are not known in advance.",
		},
	});

	// The hardened gateway role is the only principal that the knowledge base
	// resource policy exempts, so accept nothing beyond what it needs.
	const gatewayWildcards: AcceptedWildcards = {
		wildcards: [
			{
				finding: /^Resource::<GatewayInterceptor[0-9A-F]{8}\.Arn>:\*$/,
				reason:
					"Lambda invoke grants cover the versions of the interceptor function.",
			},
			{
				finding:
					/^Resource::arn:aws:bedrock-agentcore:[^:]+:[^:]+:gateway\/[a-z0-9]+-(gateway|policy-only)-\*$/,
				reason:
					"The gateway ARN has a generated suffix, so policy engine authorization matches the gateway name prefix.",
			},
		],
		anyResource: {
			actions: ["bedrock:AgenticRetrieveStream"],
			reason:
				"bedrock:AgenticRetrieveStream does not support resource-level permissions. Its internal retrieval is authorized as bedrock:Retrieve on the knowledge base.",
		},
	};
	acknowledgeWildcards(scope.gateway, gatewayWildcards);
	if (scope.simulation) {
		acknowledgeWildcards(scope.simulation, gatewayWildcards);
	}

	const runtimeReason =
		"The AgentCore Runtime construct grants log, workload identity, and code asset access.";
	acknowledgeWildcards(scope.agent, {
		wildcards: [
			{
				finding:
					/^Resource::arn:[^:]+:logs:[^:]+:[^:]+:log-group:(\/aws\/bedrock-agentcore\/runtimes\/\*(:log-stream:\*)?|\*)$/,
				reason: runtimeReason,
			},
			{
				finding:
					/^Resource::arn:[^:]+:bedrock-agentcore:[^:]+:[^:]+:workload-identity-directory\/default\/workload-identity\/\*$/,
				reason: runtimeReason,
			},
			{
				finding: /^Action::s3:(GetObject|GetBucket|List)\*$/,
				reason: runtimeReason,
			},
			{ finding: CDK_ASSETS_OBJECTS, reason: runtimeReason },
			{
				finding: /^Resource::arn:aws:bedrock:\*::foundation-model\/[^*]+$/,
				reason:
					"Cross-Region inference can route to the foundation model in any Region.",
			},
		],
		anyResource: {
			actions: [
				"xray:PutTraceSegments",
				"xray:PutTelemetryRecords",
				"xray:GetSamplingRules",
				"xray:GetSamplingTargets",
				"cloudwatch:PutMetricData",
			],
			reason:
				"X-Ray and CloudWatch metrics actions do not support resource-level permissions. PutMetricData is limited to the bedrock-agentcore namespace.",
		},
	});
}
