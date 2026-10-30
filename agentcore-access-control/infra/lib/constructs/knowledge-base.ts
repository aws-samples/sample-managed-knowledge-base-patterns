import * as cdk from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct, IDependable } from "constructs";
import {
	awsCustomResourceLogGroup,
	bucketDeploymentLogGroup,
} from "../log-groups";
import { LOCAL_ARTIFACTS } from "./bundling";

export interface KnowledgeBaseProps {
	/** Name of the knowledge base. */
	readonly name: string;
	/** Local directory with the documents and their .metadata.json ACL files. */
	readonly documentsPath: string;
}

const DOCUMENTS_PREFIX = "documents/";

/**
 * Resource layer: a Managed Knowledge Base with an ACL-enabled Amazon S3
 * data source. Each document has a <name>.metadata.json file whose
 * accessControlList lists the users (emails) allowed to retrieve it.
 */
export class KnowledgeBase extends Construct {
	readonly knowledgeBaseId: string;
	readonly knowledgeBaseArn: string;
	readonly dataSourceId: string;
	readonly bucket: s3.Bucket;

	constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
		super(scope, id);
		const { account, region } = cdk.Stack.of(this);

		this.bucket = new s3.Bucket(this, "DocumentsBucket", {
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			encryption: s3.BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});
		const documents = new s3deploy.BucketDeployment(this, "Documents", {
			sources: [
				s3deploy.Source.asset(props.documentsPath, { exclude: LOCAL_ARTIFACTS }),
			],
			destinationBucket: this.bucket,
			destinationKeyPrefix: DOCUMENTS_PREFIX,
			logGroup: bucketDeploymentLogGroup(this),
		});

		const serviceRole = new iam.Role(this, "ServiceRole", {
			assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
				conditions: {
					StringEquals: { "aws:SourceAccount": account },
					ArnLike: {
						"aws:SourceArn": `arn:aws:bedrock:${region}:${account}:knowledge-base/*`,
					},
				},
			}),
		});
		serviceRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["s3:ListBucket"],
				resources: [this.bucket.bucketArn],
				conditions: { StringEquals: { "aws:ResourceAccount": account } },
			}),
		);
		serviceRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["s3:GetObject"],
				resources: [this.bucket.arnForObjects(`${DOCUMENTS_PREFIX}*`)],
				conditions: { StringEquals: { "aws:ResourceAccount": account } },
			}),
		);
		// The service chooses the managed embedding and reranking models.
		serviceRole.addToPolicy(
			new iam.PolicyStatement({
				actions: [
					"bedrock:InvokeModel",
					"bedrock:InvokeModelWithResponseStream",
				],
				resources: ["*"],
			}),
		);

		const kb = new bedrock.CfnKnowledgeBase(this, "Resource", {
			name: props.name,
			description: "Managed knowledge base with per-document ACLs",
			roleArn: serviceRole.roleArn,
			knowledgeBaseConfiguration: {
				type: "MANAGED",
				managedKnowledgeBaseConfiguration: { embeddingModelType: "MANAGED" },
			},
		});
		kb.node.addDependency(serviceRole);
		this.knowledgeBaseId = kb.attrKnowledgeBaseId;
		this.knowledgeBaseArn = kb.attrKnowledgeBaseArn;

		const dataSource = new bedrock.CfnDataSource(this, "DataSource", {
			name: "documents",
			description: "Department documents with per-document ACLs",
			knowledgeBaseId: this.knowledgeBaseId,
			dataDeletionPolicy: "DELETE",
			dataSourceConfiguration: {
				type: "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
				managedKnowledgeBaseConnectorConfiguration: {
					deletionProtectionConfiguration: {
						deletionProtectionStatus: "DISABLED",
					},
					connectorParameters: {
						type: "S3",
						version: "1",
						// Documents without an ACL entry are not ingested, and queries
						// without userContext return nothing from this data source.
						aclEnabled: true,
						connectionConfiguration: {
							bucketName: this.bucket.bucketName,
							bucketOwnerAccountId: account,
						},
						filterConfiguration: { inclusionPrefixes: [DOCUMENTS_PREFIX] },
					},
				},
			},
		});
		dataSource.node.addDependency(documents);
		this.dataSourceId = dataSource.attrDataSourceId;

		// Start an ingestion job whenever the documents change, so the
		// knowledge base is searchable after `cdk deploy` without manual steps.
		const startIngestion: cr.AwsSdkCall = {
			service: "bedrock-agent",
			action: "StartIngestionJob",
			parameters: {
				knowledgeBaseId: this.knowledgeBaseId,
				dataSourceId: this.dataSourceId,
				description: `documents ${cdk.FileSystem.fingerprint(props.documentsPath, { exclude: LOCAL_ARTIFACTS })}`,
			},
			physicalResourceId: cr.PhysicalResourceId.fromResponse(
				"ingestionJob.ingestionJobId",
			),
		};
		const ingestion = new cr.AwsCustomResource(this, "StartIngestion", {
			onCreate: startIngestion,
			onUpdate: startIngestion,
			// The SDK client name (bedrock-agent) differs from the IAM prefix.
			policy: cr.AwsCustomResourcePolicy.fromStatements([
				new iam.PolicyStatement({
					actions: ["bedrock:StartIngestionJob"],
					resources: [this.knowledgeBaseArn],
				}),
			]),
			logGroup: awsCustomResourceLogGroup(this),
		});
		ingestion.node.addDependency(dataSource);
	}

	/**
	 * Allow a principal to search this knowledge base with the data plane
	 * APIs that the AgentCore Gateway connector target calls.
	 */
	grantRetrieve(grantee: iam.IGrantable): void {
		grantee.grantPrincipal.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["bedrock:GetKnowledgeBase", "bedrock:Retrieve"],
				resources: [this.knowledgeBaseArn],
			}),
		);
		// bedrock:AgenticRetrieveStream does not support resource-level
		// permissions. Its internal retrieval is authorized as bedrock:Retrieve
		// on each knowledge base, which the statement above scopes.
		grantee.grantPrincipal.addToPrincipalPolicy(
			new iam.PolicyStatement({
				actions: ["bedrock:AgenticRetrieveStream"],
				resources: ["*"],
			}),
		);
	}

	/**
	 * Secondary resource layer defense: attach a resource-based policy that
	 * denies Retrieve and GetDocumentContent to every principal except the
	 * given role, whichever path (another gateway, SDK, CLI) it uses. The
	 * explicit deny overrides identity-based allows in the same account.
	 *
	 * @param role The execution role of the hardened gateway.
	 * @param after Resources to create first, such as gateway targets whose
	 *   creation validates knowledge base access with their execution role.
	 */
	restrictRetrieveTo(
		role: iam.IRole,
		after: IDependable[] = [],
	): bedrock.CfnKnowledgeBasePolicy {
		const policy = new bedrock.CfnKnowledgeBasePolicy(this, "ResourcePolicy", {
			knowledgeBaseId: this.knowledgeBaseId,
			policyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Sid: "DenyRetrieveExceptGatewayRole",
						Effect: "Deny",
						Principal: "*",
						// Only these two actions are supported in knowledge base
						// resource policies, and wildcards are not allowed.
						Action: ["bedrock:Retrieve", "bedrock:GetDocumentContent"],
						Resource: this.knowledgeBaseArn,
						Condition: {
							// aws:PrincipalArn resolves to the role ARN for every session
							// of the role, so one ARN exempts all gateway sessions.
							ArnNotEquals: { "aws:PrincipalArn": role.roleArn },
						},
					},
				],
			},
		});
		for (const dependency of after) {
			policy.node.addDependency(dependency);
		}
		return policy;
	}
}
