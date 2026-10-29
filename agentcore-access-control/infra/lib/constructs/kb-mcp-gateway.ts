import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { LOCAL_ARTIFACTS } from "./bundling";
import { userContextMatchesEmailClaim } from "./cedar";
import { KnowledgeBase } from "./knowledge-base";

/** Inbound JWT authorization shared by the runtime and the gateways. */
export interface JwtAuthorizerConfig {
	readonly discoveryUrl: string;
	/** Allowed values of the access token's client_id claim. */
	readonly allowedClients: string[];
}

export interface KbMcpGatewayProps {
	/** Gateway name. Also used to derive policy engine and policy names. */
	readonly gatewayName: string;
	readonly description: string;
	readonly knowledgeBase: KnowledgeBase;
	readonly authorizer: JwtAuthorizerConfig;
	/** Primary tool layer defense: attach the userContext request interceptor. */
	readonly injectUserContext: boolean;
	/** Secondary tool layer defense: enforce the Cedar policies. */
	readonly enforcePolicy: boolean;
	/**
	 * Execution role. Defaults to a new role dedicated to this gateway. The
	 * knowledge base resource-based policy trusts the role, not the gateway,
	 * so a hardened gateway must not share its role.
	 */
	readonly role?: iam.Role;
	/** Set to DEBUG to return detailed errors to MCP clients. */
	readonly exceptionLevel?: "DEBUG";
}

/** Name of the connector target. Tools are named `kb___<Operation>`. */
export const KB_TARGET_NAME = "kb";

/** MCP tools of the target, with a short suffix for Cedar policy names. */
const KB_TOOLS = [
	{ name: `${KB_TARGET_NAME}___Retrieve`, policySuffix: "retrieve" },
	{
		name: `${KB_TARGET_NAME}___AgenticRetrieveStream`,
		policySuffix: "agentic",
	},
];

/**
 * Tool layer: an AgentCore Gateway that exposes the Managed Knowledge Base
 * Retrieve and AgenticRetrieveStream APIs as MCP tools through the
 * bedrock-knowledge-bases connector target.
 *
 * The hardened configuration enables both defenses. The bypass simulation
 * reuses this construct with one or both defenses turned off.
 */
export class KbMcpGateway extends Construct {
	readonly role: iam.Role;
	readonly gateway: agentcore.CfnGateway;
	readonly target: agentcore.CfnGatewayTarget;
	readonly interceptor?: lambda.Function;
	readonly policyEngine?: agentcore.CfnPolicyEngine;
	readonly policies: agentcore.CfnPolicy[] = [];

	constructor(scope: Construct, id: string, props: KbMcpGatewayProps) {
		super(scope, id);
		const { account, region } = cdk.Stack.of(this);

		// No confused deputy conditions in the trust policy: CreateGatewayTarget
		// validates knowledge base access by assuming this role without a
		// source ARN, and fails when conditions are present.
		this.role =
			props.role ??
			new iam.Role(this, "ExecutionRole", {
				assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
				description: `Execution role of the ${props.gatewayName} gateway`,
			});
		props.knowledgeBase.grantRetrieve(this.role);

		if (props.injectUserContext) {
			this.interceptor = new lambda.Function(this, "Interceptor", {
				description: "Injects userContext from the verified access token",
				runtime: lambda.Runtime.PYTHON_3_14,
				architecture: lambda.Architecture.ARM_64,
				handler: "interceptor.handler",
				code: lambda.Code.fromAsset(
					path.join(__dirname, "..", "..", "functions", "interceptor"),
					{ exclude: LOCAL_ARTIFACTS },
				),
				timeout: cdk.Duration.seconds(10),
				logGroup: new logs.LogGroup(this, "InterceptorLogs", {
					retention: logs.RetentionDays.ONE_MONTH,
					removalPolicy: cdk.RemovalPolicy.DESTROY,
				}),
			});
			this.interceptor.grantInvoke(this.role);
		}

		if (props.enforcePolicy) {
			// Hyphens are not allowed in policy engine and policy names.
			const policyPrefix = props.gatewayName.replace(/-/g, "_");
			this.policyEngine = new agentcore.CfnPolicyEngine(this, "PolicyEngine", {
				name: `${policyPrefix}_engine`,
				description: `Cedar policies of the ${props.gatewayName} gateway`,
			});
			// CreateGateway validates GetPolicyEngine with the execution role, and
			// the gateway calls AuthorizeAction (tools/call) and
			// PartiallyAuthorizeActions (tools/list) on the policy engine and on
			// itself. The gateway ARN has a generated suffix, so it is matched by
			// name prefix.
			this.role.addToPolicy(
				new iam.PolicyStatement({
					actions: ["bedrock-agentcore:GetPolicyEngine"],
					resources: [this.policyEngine.attrPolicyEngineArn],
				}),
			);
			this.role.addToPolicy(
				new iam.PolicyStatement({
					actions: [
						"bedrock-agentcore:AuthorizeAction",
						"bedrock-agentcore:PartiallyAuthorizeActions",
					],
					resources: [
						this.policyEngine.attrPolicyEngineArn,
						`arn:aws:bedrock-agentcore:${region}:${account}:gateway/${props.gatewayName}-*`,
					],
				}),
			);
		}

		this.gateway = new agentcore.CfnGateway(this, "Resource", {
			name: props.gatewayName,
			description: props.description,
			roleArn: this.role.roleArn,
			protocolType: "MCP",
			authorizerType: "CUSTOM_JWT",
			authorizerConfiguration: {
				customJwtAuthorizer: {
					discoveryUrl: props.authorizer.discoveryUrl,
					// Cognito access tokens carry client_id but no aud claim. Setting
					// allowedAudience as well would reject every access token.
					allowedClients: props.authorizer.allowedClients,
				},
			},
			exceptionLevel: props.exceptionLevel,
			interceptorConfigurations: this.interceptor && [
				{
					interceptionPoints: ["REQUEST"],
					interceptor: { lambda: { arn: this.interceptor.functionArn } },
					// Forward the verified Authorization header to the interceptor.
					inputConfiguration: { passRequestHeaders: true },
				},
			],
			// The policy engine evaluates tools/call after the REQUEST
			// interceptor, so the Cedar policies check the interceptor's output.
			policyEngineConfiguration: this.policyEngine && {
				arn: this.policyEngine.attrPolicyEngineArn,
				mode: "ENFORCE",
			},
		});
		// The role reference orders the gateway after the role but not after
		// its default policy, which CreateGateway needs.
		this.gateway.node.addDependency(this.role);

		// The interceptor can only write parameters that the tool schema
		// exposes, so userContext must be visible even though clients do not
		// need to set it.
		const userContextOverride = {
			path: "$.userContext",
			description: props.injectUserContext
				? "End-user identity for ACL-aware retrieval (set by the gateway interceptor)"
				: "End-user identity for ACL-aware retrieval",
			visible: true,
		};
		this.target = new agentcore.CfnGatewayTarget(this, "KbTarget", {
			gatewayIdentifier: this.gateway.attrGatewayIdentifier,
			name: KB_TARGET_NAME,
			description: "Managed Knowledge Base search tools",
			credentialProviderConfigurations: [
				{ credentialProviderType: "GATEWAY_IAM_ROLE" },
			],
			targetConfiguration: {
				mcp: {
					connector: {
						source: { connectorId: "bedrock-knowledge-bases" },
						configurations: [
							{
								name: "Retrieve",
								// The administrator binds the knowledge base. It never
								// appears in the tool schema.
								parameterValues: {
									knowledgeBaseId: props.knowledgeBase.knowledgeBaseId,
								},
								parameterOverrides: [userContextOverride],
							},
							{
								name: "AgenticRetrieveStream",
								parameterValues: {
									retrievers: [
										{
											description:
												"AnyCompany internal documents: department business plans and company-wide notices",
											configuration: {
												knowledgeBase: {
													knowledgeBaseId: props.knowledgeBase.knowledgeBaseId,
												},
											},
										},
									],
									// An empty object passes target validation but fails at
									// call time, so bind explicit values.
									agenticRetrieveConfiguration: {
										foundationModelType: "MANAGED",
										rerankingModelType: "MANAGED",
									},
									// The agent writes the answer from the results, so the
									// tool returns results only. The value is bound on the
									// target, so the agent cannot change it.
									generateResponse: false,
								},
								parameterOverrides: [userContextOverride],
							},
						],
					},
				},
			},
		});
		this.target.node.addDependency(this.role);

		const policyEngine = this.policyEngine;
		if (policyEngine) {
			// Create policies after the target: creating the target synchronizes
			// the tool schema into the policy engine, and FAIL_ON_ANY_FINDINGS
			// rejects actions that the engine does not know yet.
			const policyPrefix = props.gatewayName.replace(/-/g, "_");
			KB_TOOLS.forEach((tool, index) => {
				const policy = new agentcore.CfnPolicy(this, `Policy${index}`, {
					name: `${policyPrefix}_${tool.policySuffix}`,
					description: `Permit ${tool.name} only as the caller's own email`,
					policyEngineId: policyEngine.attrPolicyEngineId,
					definition: {
						cedar: {
							statement: userContextMatchesEmailClaim(
								tool.name,
								this.gateway.attrGatewayArn,
							),
						},
					},
					validationMode: "FAIL_ON_ANY_FINDINGS",
				});
				policy.node.addDependency(this.target);
				this.policies.push(policy);
			});
		}
	}

	/** MCP endpoint of the gateway. */
	get url(): string {
		return this.gateway.attrGatewayUrl;
	}
}
