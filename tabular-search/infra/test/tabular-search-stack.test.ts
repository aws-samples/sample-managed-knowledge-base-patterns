import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { IAM_DIR } from "../lib/policies";
import {
	DOCUMENT_PREFIX,
	TabularSearchStack,
	TabularSearchStackProps,
} from "../lib/tabular-search-stack";

const CDK_JSON_CONTEXT: Record<string, unknown> = JSON.parse(
	fs.readFileSync(path.join(__dirname, "..", "cdk.json"), "utf8"),
).context;

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const DATA_DIR = path.join(__dirname, "..", "..", "data", "finance");

function createStack(
	overrides: Partial<TabularSearchStackProps> = {},
	environmentAgnostic = false,
): {
	app: cdk.App;
	stack: TabularSearchStack;
} {
	// Synthesize with the feature flags of cdk.json, which change rendered
	// values such as ARN partitions.
	const app = new cdk.App({ context: CDK_JSON_CONTEXT });
	cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
	const stack = new TabularSearchStack(app, "TestStack", {
		env: { account: ACCOUNT, region: REGION },
		...(environmentAgnostic ? { env: undefined } : {}),
		name: "finance",
		dataDir: DATA_DIR,
		maxFileSizeMb: 200,
		...overrides,
	});
	return { app, stack };
}

function synthesize(overrides: Partial<TabularSearchStackProps> = {}): Template {
	return Template.fromStack(createStack(overrides).stack);
}

/** Return the only resource of a type, failing if there are none or several. */
function only(template: Template, type: string): { id: string; resource: any } {
	const resources = Object.entries(template.findResources(type));
	expect(resources).toHaveLength(1);
	const [id, resource] = resources[0];
	return { id, resource };
}

/** The knowledge base role is the only role with a description. */
function knowledgeBaseRole(template: Template): any {
	const roles = Object.values(
		template.findResources("AWS::IAM::Role", {
			Properties: { Description: Match.anyValue() },
		}),
	);
	expect(roles).toHaveLength(1);
	return roles[0];
}

/** Read a policy from iam/ and fill in the placeholders the way the test stack does. */
function expectedPolicy(fileName: string, bucketLogicalId: string): unknown {
	const text = fs
		.readFileSync(path.join(IAM_DIR, fileName), "utf8")
		.split("<ACCOUNT_ID>")
		.join(ACCOUNT)
		.split("<REGION>")
		.join(REGION);
	// The bucket name is only known at deploy time, so CloudFormation joins it
	// into the ARN. Render the same Fn::Join that the template contains.
	const withBucket = (value: unknown): unknown => {
		if (typeof value === "string" && value.includes("<BUCKET_NAME>")) {
			const [before, after] = value.split("<BUCKET_NAME>");
			const parts: unknown[] = [before, { Ref: bucketLogicalId }];
			if (after) {
				parts.push(after);
			}
			return { "Fn::Join": ["", parts] };
		}
		if (Array.isArray(value)) {
			return value.map(withBucket);
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, withBucket(v)]),
			);
		}
		return value;
	};
	return withBucket(JSON.parse(text));
}

describe("default deployment", () => {
	const { app, stack } = createStack();
	const template = Template.fromStack(stack);
	const bucket = only(template, "AWS::S3::Bucket");

	// An unacknowledged finding makes synth throw.
	test("passes cdk-nag AwsSolutions checks", () => {
		expect(() => app.synth()).not.toThrow();
	});

	test("the bucket blocks public access, turns off ACLs, and encrypts with SSE-S3", () => {
		expect(bucket.resource.Properties).toMatchObject({
			PublicAccessBlockConfiguration: {
				BlockPublicAcls: true,
				BlockPublicPolicy: true,
				IgnorePublicAcls: true,
				RestrictPublicBuckets: true,
			},
			OwnershipControls: {
				Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
			},
			BucketEncryption: {
				ServerSideEncryptionConfiguration: [
					{
						BucketKeyEnabled: true,
						ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
					},
				],
			},
		});
	});

	test("the bucket denies requests that don't use TLS", () => {
		template.hasResourceProperties("AWS::S3::BucketPolicy", {
			PolicyDocument: {
				Statement: Match.arrayWith([
					Match.objectLike({
						Effect: "Deny",
						Action: "s3:*",
						Condition: { Bool: { "aws:SecureTransport": "false" } },
					}),
				]),
			},
		});
	});

	test("the sample files are uploaded under the data source prefix", () => {
		template.hasResourceProperties("Custom::CDKBucketDeployment", {
			DestinationBucketName: { Ref: bucket.id },
			DestinationBucketKeyPrefix: DOCUMENT_PREFIX,
		});
	});

	// Some accounts cap Lambda memory at 512 MB, and a deploy that asks for
	// more fails (found in a test deploy).
	test("no Lambda function asks for more than 512 MB of memory", () => {
		for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
			expect(fn.Properties.MemorySize ?? 128).toBeLessThanOrEqual(512);
		}
	});

	test("the role's trust policy is iam/knowledge-base-trust-policy.json", () => {
		expect(knowledgeBaseRole(template).Properties.AssumeRolePolicyDocument).toEqual(
			expectedPolicy("knowledge-base-trust-policy.json", bucket.id),
		);
	});

	test("the role's only permissions are iam/knowledge-base-s3-read-policy.json", () => {
		const role = knowledgeBaseRole(template);
		expect(role.Properties.Policies).toEqual([
			{
				PolicyName: "finance-kb-s3-read",
				PolicyDocument: expectedPolicy("knowledge-base-s3-read-policy.json", bucket.id),
			},
		]);
		expect(role.Properties.ManagedPolicyArns).toBeUndefined();
		// No other IAM policy is attached to the role.
		const [roleId] = Object.keys(
			template.findResources("AWS::IAM::Role", {
				Properties: { Description: Match.anyValue() },
			}),
		);
		for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
			expect(policy.Properties.Roles).not.toContainEqual({ Ref: roleId });
		}
	});

	test("the knowledge base is a managed knowledge base with the managed embedding model", () => {
		template.hasResourceProperties("AWS::Bedrock::KnowledgeBase", {
			Name: "finance-kb",
			KnowledgeBaseConfiguration: {
				Type: "MANAGED",
				ManagedKnowledgeBaseConfiguration: { EmbeddingModelType: "MANAGED" },
			},
			Tags: { project: "tabular-search-sample" },
		});
	});

	test("the data source reads only the prefix, with the size filter and smart parsing", () => {
		template.hasResourceProperties("AWS::Bedrock::DataSource", {
			Name: "finance-s3",
			DataDeletionPolicy: "DELETE",
			DataSourceConfiguration: {
				Type: "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
				ManagedKnowledgeBaseConnectorConfiguration: {
					ConnectorParameters: {
						type: "S3",
						version: "1",
						connectionConfiguration: {
							bucketName: { Ref: bucket.id },
							bucketOwnerAccountId: ACCOUNT,
						},
						filterConfiguration: {
							maxFileSizeInMegaBytes: "200",
							inclusionPrefixes: [DOCUMENT_PREFIX],
						},
						aclEnabled: false,
					},
				},
			},
			VectorIngestionConfiguration: {
				ParsingConfiguration: { ParsingStrategy: "SMART_PARSING" },
			},
		});
	});

	test("the data source is created after the role and the files", () => {
		const dataSource = only(template, "AWS::Bedrock::DataSource").resource;
		const [roleId] = Object.keys(
			template.findResources("AWS::IAM::Role", {
				Properties: { Description: Match.anyValue() },
			}),
		);
		const deploymentId = only(template, "Custom::CDKBucketDeployment").id;
		expect(dataSource.DependsOn).toEqual(expect.arrayContaining([roleId, deploymentId]));
	});

	test("an ingestion job starts after the data source, with only StartIngestionJob", () => {
		const ingestion = only(template, "Custom::AWS");
		expect(ingestion.resource.DependsOn).toContain(only(template, "AWS::Bedrock::DataSource").id);
		const create = JSON.stringify(ingestion.resource.Properties.Create);
		expect(create).toContain('\\"action\\":\\"StartIngestionJob\\"');
		template.hasResourceProperties("AWS::IAM::Policy", {
			PolicyDocument: {
				Statement: [
					{
						Action: "bedrock:StartIngestionJob",
						Effect: "Allow",
						Resource: {
							"Fn::GetAtt": [only(template, "AWS::Bedrock::KnowledgeBase").id, "KnowledgeBaseArn"],
						},
					},
				],
			},
		});
	});

	test("outputs what the Python scripts read", () => {
		for (const output of ["KnowledgeBaseId", "DataSourceId", "BucketName", "DocumentPrefix"]) {
			template.hasOutput(output, {});
		}
	});
});

describe("deployment without an account or Region", () => {
	// CI synthesizes without AWS credentials, so ARNs hold pseudo parameters
	// such as <AWS::AccountId>, and the acknowledgements must still match.
	test("passes cdk-nag AwsSolutions checks", () => {
		const { app } = createStack({}, true);
		expect(() => app.synth()).not.toThrow();
	});
});

describe("context values", () => {
	test("name sets the knowledge base, data source, and policy names", () => {
		const template = synthesize({ name: "team-sales" });
		template.hasResourceProperties("AWS::Bedrock::KnowledgeBase", { Name: "team-sales-kb" });
		template.hasResourceProperties("AWS::Bedrock::DataSource", { Name: "team-sales-s3" });
		expect(knowledgeBaseRole(template).Properties.Policies[0].PolicyName).toBe(
			"team-sales-kb-s3-read",
		);
	});

	test.each(["F", "a", "bad--name", "-finance", "finance_kb", "x".repeat(33)])(
		"rejects the name %p",
		(name) => {
			expect(() => createStack({ name })).toThrow(/lowercase letters/);
		},
	);

	test("maxFileSizeMb sets the size filter and resyncs when it changes", () => {
		const template = synthesize({ maxFileSizeMb: 500 });
		template.hasResourceProperties("AWS::Bedrock::DataSource", {
			DataSourceConfiguration: {
				ManagedKnowledgeBaseConnectorConfiguration: {
					ConnectorParameters: {
						filterConfiguration: { maxFileSizeInMegaBytes: "500" },
					},
				},
			},
		});
		expect(JSON.stringify(only(template, "Custom::AWS").resource.Properties.Create)).toContain(
			"max 500 MB",
		);
	});

	test.each([0, -1, 1.5, Number.NaN])("rejects maxFileSizeMb %p", (maxFileSizeMb) => {
		expect(() => createStack({ maxFileSizeMb })).toThrow(/maxFileSizeMb/);
	});
});

describe("clean up", () => {
	const template = synthesize();

	test("the bucket and its objects are deleted with the stack", () => {
		const bucket = only(template, "AWS::S3::Bucket").resource;
		expect(bucket.DeletionPolicy).toBe("Delete");
		template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
	});

	test("no resource is retained when the stack is deleted", () => {
		for (const resource of Object.values(template.toJSON().Resources) as any[]) {
			expect(resource.DeletionPolicy ?? "Delete").toBe("Delete");
		}
	});
});

describe("log groups", () => {
	const template = synthesize();
	const logGroups = template.findResources("AWS::Logs::LogGroup");

	test("every log group is deleted with the stack and keeps events for 30 days", () => {
		expect(Object.keys(logGroups).length).toBeGreaterThan(0);
		for (const logGroup of Object.values(logGroups)) {
			expect(logGroup.DeletionPolicy).toBe("Delete");
			expect(logGroup.Properties.RetentionInDays).toBe(30);
		}
	});

	test("every Lambda function logs to a log group of the stack", () => {
		const functions = template.findResources("AWS::Lambda::Function");
		expect(Object.keys(functions).length).toBeGreaterThan(0);
		for (const fn of Object.values(functions)) {
			expect(Object.keys(logGroups)).toContain(fn.Properties.LoggingConfig?.LogGroup?.Ref);
		}
	});

	test("log groups are deleted after every role, so no function can recreate them", () => {
		for (const role of Object.values(template.findResources("AWS::IAM::Role"))) {
			expect(role.DependsOn).toEqual(expect.arrayContaining(Object.keys(logGroups)));
		}
	});
});
