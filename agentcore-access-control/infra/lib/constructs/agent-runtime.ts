import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { agentCodeBundling } from "./bundling";
import { JwtAuthorizerConfig } from "./kb-mcp-gateway";

export interface AgentRuntimeProps {
	/** Runtime name: letters, digits, and underscores. */
	readonly runtimeName: string;
	/** Directory of the agent uv project. */
	readonly agentPath: string;
	/** MCP endpoint of the hardened gateway. */
	readonly gatewayUrl: string;
	/** Amazon Bedrock model or cross-Region inference profile ID. */
	readonly modelId: string;
	readonly authorizer: JwtAuthorizerConfig;
}

const PYTHON_VERSION = "3.13";
const INFERENCE_PROFILE_PREFIXES = ["global", "us", "eu", "apac", "jp", "au"];

/**
 * The Strands agent on AgentCore Runtime. The runtime validates the user's
 * access token and forwards the Authorization header to the agent, which
 * presents the same token to the gateway. The agent's role has no access to
 * the knowledge base.
 */
export class AgentRuntime extends Construct {
	readonly runtime: agentcore.Runtime;

	constructor(scope: Construct, id: string, props: AgentRuntimeProps) {
		super(scope, id);

		const artifact = agentcore.AgentRuntimeArtifact.fromCodeAsset({
			path: props.agentPath,
			runtime: agentcore.AgentCoreRuntime.PYTHON_3_13,
			entrypoint: ["main.py"],
			bundling: agentCodeBundling(props.agentPath, PYTHON_VERSION),
			exclude: [".venv", "tests", "**/__pycache__", ".*_cache"],
		});
		this.runtime = new agentcore.Runtime(this, "Runtime", {
			runtimeName: props.runtimeName,
			description: "Strands agent that searches the knowledge base via MCP",
			agentRuntimeArtifact: artifact,
			protocolConfiguration: agentcore.ProtocolType.HTTP,
			authorizerConfiguration:
				agentcore.RuntimeAuthorizerConfiguration.usingJWT(
					props.authorizer.discoveryUrl,
					props.authorizer.allowedClients,
				),
			requestHeaderConfiguration: { allowlistedHeaders: ["Authorization"] },
			environmentVariables: {
				GATEWAY_URL: props.gatewayUrl,
				MODEL_ID: props.modelId,
			},
		});
		// The runtime binds its artifact lazily when the template is rendered.
		// Binding is idempotent; doing it now adds the code asset read grant
		// before aspects (cdk-nag acknowledgements) inspect the role policy.
		artifact.bind(this.runtime, this.runtime);

		this.runtime.addToRolePolicy(
			new iam.PolicyStatement({
				actions: [
					"bedrock:InvokeModel",
					"bedrock:InvokeModelWithResponseStream",
				],
				resources: modelArns(cdk.Stack.of(this), props.modelId),
			}),
		);
	}
}

/**
 * ARNs to invoke a model directly or through a cross-Region inference
 * profile, which can route to the foundation model in any member Region.
 */
function modelArns(stack: cdk.Stack, modelId: string): string[] {
	const [prefix, ...rest] = modelId.split(".");
	if (INFERENCE_PROFILE_PREFIXES.includes(prefix) && rest.length > 0) {
		return [
			`arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`,
			`arn:aws:bedrock:*::foundation-model/${rest.join(".")}`,
		];
	}
	return [`arn:aws:bedrock:${stack.region}::foundation-model/${modelId}`];
}
