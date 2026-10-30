import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import { AwsSolutionsChecks } from "cdk-nag";
import { KbMcpGateway } from "../lib/constructs/kb-mcp-gateway";
import { ManagedKbAclStack } from "../lib/managed-kb-acl-stack";

const CDK_JSON_CONTEXT: Record<string, unknown> = JSON.parse(
	fs.readFileSync(path.join(__dirname, "..", "cdk.json"), "utf8"),
).context;

interface StackOptions {
	enableBypassSimulation?: boolean;
	allowLocalhostCallback?: boolean;
	stackName?: string;
}

interface Synthesized {
	app: cdk.App;
	template: Template;
}

function createStack(options: StackOptions = {}): {
	app: cdk.App;
	stack: ManagedKbAclStack;
} {
	// Synthesize with the feature flags of cdk.json, which change rendered
	// values such as ARN partitions, and skip asset bundling (uv and npm builds).
	const app = new cdk.App({
		context: { ...CDK_JSON_CONTEXT, "aws:cdk:bundling-stacks": [] },
	});
	cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
	const stack = new ManagedKbAclStack(app, options.stackName ?? "TestStack", {
		env: { account: "123456789012", region: "us-east-1" },
		agentModelId: "global.anthropic.claude-sonnet-5-5",
		enableBypassSimulation: options.enableBypassSimulation ?? false,
		allowLocalhostCallback: options.allowLocalhostCallback ?? false,
	});
	return { app, stack };
}

function synthesize(options: StackOptions = {}): Synthesized {
	const { app, stack } = createStack(options);
	return { app, template: Template.fromStack(stack) };
}

/** Return the logical ID of the only resource of a type that matches props. */
function logicalId(
	template: Template,
	type: string,
	props: object = {},
): string {
	const ids = Object.keys(template.findResources(type, { Properties: props }));
	expect(ids).toHaveLength(1);
	return ids[0];
}

describe("default deployment", () => {
	const { app, template } = synthesize();

	test("passes cdk-nag AwsSolutions checks", () => {
		expect(() => app.synth()).not.toThrow();
	});

	test("creates only the hardened gateway", () => {
		template.resourceCountIs("AWS::BedrockAgentCore::Gateway", 1);
		template.resourceCountIs("AWS::BedrockAgentCore::GatewayTarget", 1);
	});

	test("gateway injects userContext and enforces Cedar policies", () => {
		template.hasResourceProperties("AWS::BedrockAgentCore::Gateway", {
			AuthorizerType: "CUSTOM_JWT",
			AuthorizerConfiguration: {
				CustomJWTAuthorizer: {
					AllowedClients: [Match.anyValue()],
					AllowedAudience: Match.absent(),
				},
			},
			InterceptorConfigurations: [
				{
					InterceptionPoints: ["REQUEST"],
					InputConfiguration: { PassRequestHeaders: true },
				},
			],
			PolicyEngineConfiguration: { Mode: "ENFORCE" },
		});
	});

	test("connector target exposes userContext on both tools", () => {
		const override = Match.objectLike({ Path: "$.userContext", Visible: true });
		template.hasResourceProperties("AWS::BedrockAgentCore::GatewayTarget", {
			TargetConfiguration: {
				Mcp: {
					Connector: {
						Source: { ConnectorId: "bedrock-knowledge-bases" },
						Configurations: [
							Match.objectLike({
								Name: "Retrieve",
								ParameterOverrides: [override],
							}),
							Match.objectLike({
								Name: "AgenticRetrieveStream",
								ParameterOverrides: [override],
							}),
						],
					},
				},
			},
		});
	});

	test("agentic retrieval returns results without a generated answer", () => {
		template.hasResourceProperties("AWS::BedrockAgentCore::GatewayTarget", {
			TargetConfiguration: {
				Mcp: {
					Connector: {
						Configurations: Match.arrayWith([
							Match.objectLike({
								Name: "AgenticRetrieveStream",
								ParameterValues: Match.objectLike({ generateResponse: false }),
							}),
						]),
					},
				},
			},
		});
	});

	test("Cedar policies compare userContext with the email claim", () => {
		const policies = template.findResources("AWS::BedrockAgentCore::Policy");
		const statements = Object.values(policies).map((policy) =>
			JSON.stringify(policy.Properties.Definition.Cedar.Statement),
		);
		expect(statements).toHaveLength(2);
		for (const [index, action] of [
			"kb___Retrieve",
			"kb___AgenticRetrieveStream",
		].entries()) {
			expect(statements[index]).toContain(`AgentCore::Action::\\"${action}\\"`);
			expect(statements[index]).toContain(
				'context.input.userContext.userId == principal.getTag(\\"email\\")',
			);
		}
	});

	test("Cedar policies are created after the gateway target", () => {
		const targetId = logicalId(
			template,
			"AWS::BedrockAgentCore::GatewayTarget",
		);
		const policies = template.findResources("AWS::BedrockAgentCore::Policy");
		for (const policy of Object.values(policies)) {
			expect(policy.DependsOn).toContain(targetId);
		}
	});

	test("knowledge base resource policy denies every principal except the gateway role", () => {
		const gatewayRoleId = Object.keys(
			template.findResources("AWS::IAM::Role", {
				Properties: {
					Description: Match.stringLikeRegexp(
						"Execution role of the .*-gateway gateway",
					),
				},
			}),
		)[0];
		template.hasResourceProperties("AWS::Bedrock::KnowledgeBasePolicy", {
			PolicyDocument: {
				Statement: [
					{
						Effect: "Deny",
						Principal: "*",
						Action: ["bedrock:Retrieve", "bedrock:GetDocumentContent"],
						Condition: {
							ArnNotEquals: {
								"aws:PrincipalArn": { "Fn::GetAtt": [gatewayRoleId, "Arn"] },
							},
						},
					},
				],
			},
		});
		const policy = Object.values(
			template.findResources("AWS::Bedrock::KnowledgeBasePolicy"),
		)[0];
		expect(policy.DependsOn).toContain(
			logicalId(template, "AWS::BedrockAgentCore::GatewayTarget"),
		);
	});

	test("data source enables ACLs", () => {
		template.hasResourceProperties("AWS::Bedrock::DataSource", {
			DataSourceConfiguration: {
				ManagedKnowledgeBaseConnectorConfiguration: {
					ConnectorParameters: Match.objectLike({ aclEnabled: true }),
				},
			},
		});
	});

	test("runtime validates the user token and forwards the Authorization header", () => {
		template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
			AuthorizerConfiguration: {
				CustomJWTAuthorizer: { AllowedClients: [Match.anyValue()] },
			},
			RequestHeaderConfiguration: { RequestHeaderAllowlist: ["Authorization"] },
			EnvironmentVariables: {
				GATEWAY_URL: Match.anyValue(),
				MODEL_ID: "global.anthropic.claude-sonnet-5-5",
			},
		});
	});

	test("pre token generation trigger uses event version V2_0", () => {
		template.hasResourceProperties("AWS::Cognito::UserPool", {
			UserPoolTier: "ESSENTIALS",
			LambdaConfig: { PreTokenGenerationConfig: { LambdaVersion: "V2_0" } },
			AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
			Schema: Match.arrayWith([
				Match.objectLike({ Name: "email", Mutable: false, Required: true }),
			]),
		});
	});

	test("demo user password is read by the function, never passed as a property", () => {
		const password = Object.values(
			template.findResources("Custom::DemoUserPassword"),
		);
		expect(password).toHaveLength(1);
		expect(Object.keys(password[0].Properties).sort()).toEqual([
			"SecretArn",
			"ServiceToken",
			"UserPoolId",
			"Usernames",
		]);
		expect(password[0].Properties.SecretArn).toEqual({
			Ref: logicalId(template, "AWS::SecretsManager::Secret"),
		});
		// Neither a response field nor a dynamic reference of the secret value.
		const rendered = JSON.stringify(template.toJSON());
		expect(rendered).not.toMatch(/"SecretString"|resolve:secretsmanager/);
		const sdkCalls = JSON.stringify(template.findResources("Custom::AWS"));
		expect(sdkCalls).not.toMatch(/GetSecretValue|AdminSetUserPassword/);
	});

	test("response headers policy name avoids the reserved Managed prefix", () => {
		const policies = template.findResources(
			"AWS::CloudFront::ResponseHeadersPolicy",
		);
		for (const policy of Object.values(policies)) {
			expect(policy.Properties.ResponseHeadersPolicyConfig.Name).not.toMatch(
				/^managed/i,
			);
		}
	});

	test("web client does not allow localhost callbacks by default", () => {
		const clients = template.findResources("AWS::Cognito::UserPoolClient");
		expect(JSON.stringify(clients)).not.toContain("localhost");
	});
});

describe("bypass simulation", () => {
	const { app, template } = synthesize({ enableBypassSimulation: true });

	test("passes cdk-nag AwsSolutions checks", () => {
		expect(() => app.synth()).not.toThrow();
	});

	test("adds a policy-only gateway and a gateway without controls", () => {
		template.resourceCountIs("AWS::BedrockAgentCore::Gateway", 3);
		const gateways = Object.values(
			template.findResources("AWS::BedrockAgentCore::Gateway"),
		).map((gateway) => gateway.Properties);
		const byName = (suffix: string) =>
			gateways.find((props) => String(props.Name).endsWith(suffix));

		expect(byName("-policy-only")?.InterceptorConfigurations).toBeUndefined();
		expect(byName("-policy-only")?.PolicyEngineConfiguration).toEqual(
			expect.objectContaining({ Mode: "ENFORCE" }),
		);
		expect(byName("-no-controls")?.InterceptorConfigurations).toBeUndefined();
		expect(byName("-no-controls")?.PolicyEngineConfiguration).toBeUndefined();
	});

	test("simulation gateways do not share the hardened gateway role", () => {
		const gateways = Object.values(
			template.findResources("AWS::BedrockAgentCore::Gateway"),
		).map((gateway) => gateway.Properties);
		const hardened = gateways.find((props) =>
			String(props.Name).endsWith("-gateway"),
		);
		for (const props of gateways.filter((p) => p !== hardened)) {
			expect(props.RoleArn).not.toEqual(hardened?.RoleArn);
		}
	});

	test("resource policy is created after every gateway target", () => {
		const targets = Object.keys(
			template.findResources("AWS::BedrockAgentCore::GatewayTarget"),
		);
		const policy = Object.values(
			template.findResources("AWS::Bedrock::KnowledgeBasePolicy"),
		)[0];
		expect(targets).toHaveLength(3);
		expect(policy.DependsOn).toEqual(expect.arrayContaining(targets));
	});
});

describe("cdk-nag wildcard acknowledgements", () => {
	/** Add a statement to the hardened gateway role and synthesize. */
	function synthWithGatewayGrant(
		statement: iam.PolicyStatementProps,
	): () => void {
		const { app, stack } = createStack();
		const gateway = stack.node.findChild("Gateway") as KbMcpGateway;
		gateway.role.addToPolicy(new iam.PolicyStatement(statement));
		return () => app.synth();
	}

	test("reports a wildcard action added to the gateway role", () => {
		expect(
			synthWithGatewayGrant({
				actions: ["bedrock:*", "s3:*"],
				resources: ["*"],
			}),
		).toThrow(/AwsSolutions-IAM5/);
	});

	test("reports another action granted on every resource to the gateway role", () => {
		expect(
			synthWithGatewayGrant({
				actions: ["bedrock:InvokeModel"],
				resources: ["*"],
			}),
		).toThrow(/AwsSolutions-IAM5/);
	});
});

describe("local development", () => {
	test("adds the localhost callback when allowed", () => {
		const { template } = synthesize({ allowLocalhostCallback: true });
		template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
			CallbackURLs: Match.arrayWith(["http://localhost:5173"]),
		});
	});
});

describe("resource names", () => {
	const { template } = synthesize({
		enableBypassSimulation: true,
		stackName: "AnyCompanyInternalAssistantKnowledgeBaseStack",
	});

	const names = (type: string, property = "Name"): string[] =>
		Object.values(template.findResources(type)).map((resource) =>
			String(resource.Properties[property]),
		);

	test.each([
		["AWS::BedrockAgentCore::Gateway", "Name", /^([0-9a-zA-Z][-]?){1,48}$/],
		[
			"AWS::BedrockAgentCore::PolicyEngine",
			"Name",
			/^[A-Za-z][A-Za-z0-9_]{0,47}$/,
		],
		["AWS::BedrockAgentCore::Policy", "Name", /^[A-Za-z][A-Za-z0-9_]{0,47}$/],
		[
			"AWS::BedrockAgentCore::Runtime",
			"AgentRuntimeName",
			/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
		],
	])("%s names fit the CloudFormation constraints for long stack names", (type, property, pattern) => {
		const values = names(type, property);
		expect(values.length).toBeGreaterThan(0);
		for (const value of values) {
			expect(value).toMatch(pattern);
		}
	});
});

describe("log groups", () => {
	const { template } = synthesize({ enableBypassSimulation: true });
	const logGroups = template.findResources("AWS::Logs::LogGroup");

	test("every log group is deleted with the stack", () => {
		for (const logGroup of Object.values(logGroups)) {
			expect(logGroup.DeletionPolicy).toBe("Delete");
		}
	});

	test("every Lambda function logs to a log group of the stack", () => {
		const functions = template.findResources("AWS::Lambda::Function");
		expect(Object.keys(functions).length).toBeGreaterThan(0);
		for (const fn of Object.values(functions)) {
			expect(Object.keys(logGroups)).toContain(
				fn.Properties.LoggingConfig?.LogGroup?.Ref,
			);
		}
	});

	test("log groups are deleted after every role, so no function can recreate them", () => {
		const roles = template.findResources("AWS::IAM::Role");
		expect(Object.keys(roles).length).toBeGreaterThan(0);
		for (const role of Object.values(roles)) {
			expect(role.DependsOn).toEqual(
				expect.arrayContaining(Object.keys(logGroups)),
			);
		}
	});
});
