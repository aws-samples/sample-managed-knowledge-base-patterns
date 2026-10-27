import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { AgentRuntime } from "./constructs/agent-runtime";
import { BypassSimulation } from "./constructs/bypass-simulation";
import { FrontendHosting } from "./constructs/frontend-hosting";
import { Identity } from "./constructs/identity";
import { KbMcpGateway } from "./constructs/kb-mcp-gateway";
import { KnowledgeBase } from "./constructs/knowledge-base";
import { addNagSuppressions } from "./nag-suppressions";

export interface ManagedKbAclStackProps extends cdk.StackProps {
	/** Amazon Bedrock model or inference profile ID for the agent. */
	readonly agentModelId: string;
	/** Deploy the gateways that skip tool layer defenses, for verification only. */
	readonly enableBypassSimulation: boolean;
	/** Allow http://localhost:5173 as a Cognito callback for local development. */
	readonly allowLocalhostCallback: boolean;
}

/** Users in the document ACLs (infra/data/documents/*.metadata.json). */
export const DEMO_USER_EMAILS = ["user-a@example.com", "user-b@example.com"];
export const LOCALHOST_URL = "http://localhost:5173";

const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * The AnyCompany internal assistant: a web app, a Strands agent on
 * AgentCore Runtime, and a Managed Knowledge Base exposed as MCP tools
 * through AgentCore Gateway, with every defense from the blog post:
 *
 * | Layer    | Primary defense     | Secondary defense      |
 * | -------- | ------------------- | ---------------------- |
 * | Tool     | Request interceptor | AgentCore Policy       |
 * | Resource | ACL awareness       | Resource-based policy  |
 */
export class ManagedKbAclStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props: ManagedKbAclStackProps) {
		super(scope, id, props);
		// Resource name prefix. Stack names start with a letter, and 20
		// characters keep every derived name within the 48 character limits of
		// gateways, policy engines, policies, and runtimes.
		const prefix = this.stackName
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "")
			.slice(0, 20);

		// Cognito domain prefixes are global per Region, so add a suffix that is
		// unique to this stack. Reserved words such as "aws" are not allowed.
		const stackSuffix = cdk.Fn.select(
			0,
			cdk.Fn.split("-", cdk.Fn.select(2, cdk.Fn.split("/", this.stackId))),
		);
		const cognitoDomainPrefix = `kb-acl-${stackSuffix}`;
		const cognitoDomainUrl = `https://${cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`;

		const hosting = new FrontendHosting(this, "Frontend", {
			connectSources: [
				cognitoDomainUrl,
				`https://cognito-idp.${this.region}.amazonaws.com`,
				`https://bedrock-agentcore.${this.region}.amazonaws.com`,
			],
		});

		const identity = new Identity(this, "Identity", {
			domainPrefix: cognitoDomainPrefix,
			callbackUrls: [
				hosting.url,
				...(props.allowLocalhostCallback ? [LOCALHOST_URL] : []),
			],
			demoUserEmails: DEMO_USER_EMAILS,
		});

		const knowledgeBase = new KnowledgeBase(this, "KnowledgeBase", {
			name: `${prefix}-kb`,
			documentsPath: path.join(REPO_ROOT, "infra", "data", "documents"),
		});

		const gateway = new KbMcpGateway(this, "Gateway", {
			gatewayName: `${prefix}-gateway`,
			description:
				"Managed KB tools with userContext injection and Cedar checks",
			knowledgeBase,
			authorizer: identity.jwtAuthorizer,
			injectUserContext: true,
			enforcePolicy: true,
		});

		const simulation = props.enableBypassSimulation
			? new BypassSimulation(this, "BypassSimulation", {
					namePrefix: prefix,
					knowledgeBase,
					authorizer: identity.jwtAuthorizer,
				})
			: undefined;

		knowledgeBase.restrictRetrieveTo(gateway.role, [
			gateway.target,
			...(simulation?.targets ?? []),
		]);

		const agent = new AgentRuntime(this, "Agent", {
			runtimeName: `${prefix}_agent`,
			agentPath: path.join(REPO_ROOT, "agent"),
			gatewayUrl: gateway.url,
			modelId: props.agentModelId,
			authorizer: identity.jwtAuthorizer,
		});

		hosting.deploy(path.join(REPO_ROOT, "frontend"), {
			region: this.region,
			userPoolId: identity.userPool.userPoolId,
			userPoolClientId: identity.webClient.userPoolClientId,
			cognitoDomain: cognitoDomainUrl,
			agentRuntimeArn: agent.runtime.agentRuntimeArn,
		});

		const outputs: Record<string, string> = {
			WebAppUrl: hosting.url,
			DemoUserPasswordSecretArn: identity.demoUserPassword.secretArn,
			UserPoolId: identity.userPool.userPoolId,
			UserPoolClientId: identity.webClient.userPoolClientId,
			CognitoDomainUrl: cognitoDomainUrl,
			AgentRuntimeArn: agent.runtime.agentRuntimeArn,
			GatewayUrl: gateway.url,
			GatewayRoleArn: gateway.role.roleArn,
			KnowledgeBaseId: knowledgeBase.knowledgeBaseId,
			KnowledgeBaseArn: knowledgeBase.knowledgeBaseArn,
			DataSourceId: knowledgeBase.dataSourceId,
		};
		if (simulation) {
			outputs.PolicyOnlyGatewayUrl = simulation.policyOnlyGateway.url;
			outputs.NoControlsGatewayUrl = simulation.noControlsGateway.url;
		}
		for (const [name, value] of Object.entries(outputs)) {
			new cdk.CfnOutput(this, name, { value });
		}

		addNagSuppressions(this, {
			hosting,
			identity,
			knowledgeBase,
			gateway,
			agent,
			simulation,
		});
	}
}
