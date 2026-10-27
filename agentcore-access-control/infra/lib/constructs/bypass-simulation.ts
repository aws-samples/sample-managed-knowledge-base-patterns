import * as iam from "aws-cdk-lib/aws-iam";
import { Construct, IDependable } from "constructs";
import { JwtAuthorizerConfig, KbMcpGateway } from "./kb-mcp-gateway";
import { KnowledgeBase } from "./knowledge-base";

export interface BypassSimulationProps {
	/** Prefix for the gateway names. */
	readonly namePrefix: string;
	readonly knowledgeBase: KnowledgeBase;
	readonly authorizer: JwtAuthorizerConfig;
}

/**
 * Opt-in gateways that reproduce what happens when tool layer defenses are
 * missing. They are intentionally weaker than the main gateway, so the stack
 * deploys them only when enableBypassSimulation is true:
 *
 * - policy-only: the hardened gateway without its interceptor, so that
 *   AgentCore Policy alone must deny a spoofed userContext.
 * - no-controls: a second gateway for the same knowledge base without an
 *   interceptor or a policy engine, so that only the knowledge base
 *   resource-based policy stands between the caller and the documents.
 *
 * Both run as a simulation role that the resource-based policy does not
 * exempt. The role's identity-based policy allows retrieval, so any denial
 * comes from the layers under test.
 */
export class BypassSimulation extends Construct {
	readonly role: iam.Role;
	readonly policyOnlyGateway: KbMcpGateway;
	readonly noControlsGateway: KbMcpGateway;

	constructor(scope: Construct, id: string, props: BypassSimulationProps) {
		super(scope, id);

		this.role = new iam.Role(this, "Role", {
			assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
			description: "Execution role of the bypass simulation gateways",
		});

		this.policyOnlyGateway = new KbMcpGateway(this, "PolicyOnly", {
			gatewayName: `${props.namePrefix}-policy-only`,
			description: "Simulation: AgentCore Policy without the interceptor",
			knowledgeBase: props.knowledgeBase,
			authorizer: props.authorizer,
			injectUserContext: false,
			enforcePolicy: true,
			role: this.role,
			exceptionLevel: "DEBUG",
		});
		this.noControlsGateway = new KbMcpGateway(this, "NoControls", {
			gatewayName: `${props.namePrefix}-no-controls`,
			description: "Simulation: no interceptor and no AgentCore Policy",
			knowledgeBase: props.knowledgeBase,
			authorizer: props.authorizer,
			injectUserContext: false,
			enforcePolicy: false,
			role: this.role,
			exceptionLevel: "DEBUG",
		});
	}

	/** Gateway targets, to create before the resource-based policy. */
	get targets(): IDependable[] {
		return [this.policyOnlyGateway.target, this.noControlsGateway.target];
	}
}
