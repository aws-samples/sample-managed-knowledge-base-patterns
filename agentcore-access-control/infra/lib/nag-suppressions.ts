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

/**
 * Acknowledge each AwsSolutions-IAM5 finding (one per wildcard action or
 * resource) of the IAM policies under a scope. Runs as a read-only aspect,
 * after constructs such as the runtime have added their lazy grants.
 */
class AcknowledgeWildcardPermissions implements cdk.IAspect {
	constructor(private readonly reason: string) {}

	visit(node: IConstruct): void {
		if (!(node instanceof iam.CfnPolicy || node instanceof iam.CfnRole)) {
			return;
		}
		const findings = rules.iam.IAMNoWildcardPermissions(node);
		if (Array.isArray(findings)) {
			for (const finding of findings) {
				acknowledge(node, `AwsSolutions-IAM5[${finding}]`, this.reason);
			}
		}
	}
}

function acknowledgeWildcards(scope: IConstruct, reason: string): void {
	cdk.Aspects.of(scope).add(new AcknowledgeWildcardPermissions(reason), {
		priority: cdk.AspectPriority.READONLY,
	});
}

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
			acknowledgeWildcards(
				child,
				"The CDK BucketDeployment handler copies objects between the asset bucket and the destination buckets.",
			);
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

	acknowledgeWildcards(
		scope.knowledgeBase,
		"The knowledge base service role reads every object under the documents/ prefix, and the service selects the managed embedding and reranking models.",
	);

	const gatewayReason =
		"bedrock:AgenticRetrieveStream does not support resource-level permissions, the gateway ARN has a generated suffix, and Lambda invoke grants cover function versions.";
	acknowledgeWildcards(scope.gateway, gatewayReason);
	if (scope.simulation) {
		acknowledgeWildcards(scope.simulation, gatewayReason);
	}

	acknowledgeWildcards(
		scope.agent,
		"The AgentCore Runtime construct grants log, workload identity, and code asset access, and cross-Region inference can route to the foundation model in any Region.",
	);
}
