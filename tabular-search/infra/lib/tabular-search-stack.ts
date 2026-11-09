import * as cdk from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import {
	addAutoDeleteObjectsLogGroup,
	awsCustomResourceLogGroup,
	bucketDeploymentLogGroup,
	deleteLogGroupsAfterRoles,
} from "./log-groups";
import { addNagSuppressions } from "./nag-suppressions";
import { renderPolicy } from "./policies";

export interface TabularSearchStackProps extends cdk.StackProps {
	/**
	 * Base name of the knowledge base (`<name>-kb`) and the data source
	 * (`<name>-s3`). Lowercase letters, numbers, and single hyphens.
	 */
	readonly name: string;
	/** Local folder of table files and documents to upload. */
	readonly dataDir: string;
	/** Largest file that the data source ingests, in MB. */
	readonly maxFileSizeMb: number;
}

/** The scripts and the data source both use this prefix. */
export const DOCUMENT_PREFIX = "finance/";

/** Lowercase for S3 and no doubled hyphens for knowledge base names. */
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Local files that must not be uploaded, such as .DS_Store. */
const LOCAL_ARTIFACTS = [".*", "__pycache__"];

/**
 * A Managed Knowledge Base over an Amazon S3 bucket of table files and
 * documents, for tabular search with AgenticRetrieveStream.
 *
 * Tabular search has no setting of its own. It runs inside agentic retrieval
 * whenever a retrieved passage comes from a CSV or Excel file and the
 * question needs a calculation, so this stack only has to get the files
 * ingested with the right file types.
 */
export class TabularSearchStack extends cdk.Stack {
	readonly bucket: s3.Bucket;
	readonly serviceRole: iam.Role;
	readonly knowledgeBase: bedrock.CfnKnowledgeBase;
	readonly dataSource: bedrock.CfnDataSource;

	constructor(scope: Construct, id: string, props: TabularSearchStackProps) {
		super(scope, id, props);

		if (
			!(props.name.length >= 2 && props.name.length <= 32) ||
			!NAME_PATTERN.test(props.name)
		) {
			throw new Error(
				`name "${props.name}" must be 2 to 32 lowercase letters, numbers, and single hyphens.`,
			);
		}
		if (!Number.isInteger(props.maxFileSizeMb) || props.maxFileSizeMb < 1) {
			throw new Error(
				`maxFileSizeMb must be a positive whole number, not ${props.maxFileSizeMb}.`,
			);
		}

		cdk.Tags.of(this).add("project", "tabular-search-sample");

		this.bucket = new s3.Bucket(this, "DocumentsBucket", {
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
			encryption: s3.BucketEncryption.S3_MANAGED,
			bucketKeyEnabled: true,
			enforceSSL: true,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		const documents = new s3deploy.BucketDeployment(this, "Documents", {
			sources: [s3deploy.Source.asset(props.dataDir, { exclude: LOCAL_ARTIFACTS })],
			destinationBucket: this.bucket,
			destinationKeyPrefix: DOCUMENT_PREFIX,
			// The handler unzips the asset in /tmp before copying, so leave room
			// for two copies of the largest file the data source ingests. Some
			// accounts cap Lambda memory at 512 MB, and BucketDeployment asks
			// for 1024 MB by default, which those accounts reject.
			memoryLimit: 512,
			ephemeralStorageSize: cdk.Size.mebibytes(
				Math.min(10240, Math.max(1024, props.maxFileSizeMb * 3)),
			),
			logGroup: bucketDeploymentLogGroup(this),
		});

		// The trust policy and the S3 read policy are the files in iam/, so the
		// deployed role always matches the documented policies.
		this.serviceRole = new iam.Role(this, "KnowledgeBaseRole", {
			assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
			description: "Lets Amazon Bedrock read the tabular search sample files",
			inlinePolicies: {
				[`${props.name}-kb-s3-read`]: iam.PolicyDocument.fromJson(
					renderPolicy("knowledge-base-s3-read-policy.json", {
						ACCOUNT_ID: this.account,
						BUCKET_NAME: this.bucket.bucketName,
					}),
				),
			},
		});
		(this.serviceRole.node.defaultChild as iam.CfnRole).assumeRolePolicyDocument =
			renderPolicy("knowledge-base-trust-policy.json", {
				ACCOUNT_ID: this.account,
				REGION: this.region,
			});

		this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
			name: `${props.name}-kb`,
			description: "Tabular search sample: finance tables and documents",
			roleArn: this.serviceRole.roleArn,
			knowledgeBaseConfiguration: {
				type: "MANAGED",
				managedKnowledgeBaseConfiguration: { embeddingModelType: "MANAGED" },
			},
		});

		this.dataSource = new bedrock.CfnDataSource(this, "DataSource", {
			knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
			name: `${props.name}-s3`,
			description: `Tabular search sample: S3 files under ${DOCUMENT_PREFIX}`,
			// Remove the indexed content with the data source, so cdk destroy
			// leaves nothing behind.
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
						connectionConfiguration: {
							bucketName: this.bucket.bucketName,
							bucketOwnerAccountId: this.account,
						},
						filterConfiguration: {
							// In MB, as a string. Files larger than this aren't
							// ingested, so the code can't read them.
							maxFileSizeInMegaBytes: String(props.maxFileSizeMb),
							inclusionPrefixes: [DOCUMENT_PREFIX],
						},
						aclEnabled: false,
					},
				},
			},
			vectorIngestionConfiguration: {
				parsingConfiguration: { parsingStrategy: "SMART_PARSING" },
			},
		});
		// Bedrock checks that it can read the bucket when the data source is
		// created, so the role's policy and the files come first.
		this.dataSource.node.addDependency(this.serviceRole, documents);

		// Sync after every deploy that changes the files or the size filter, so
		// the knowledge base is ready to ask without a manual step. The job runs
		// for a few minutes after the deploy finishes; 01_check_file_types.py
		// waits for it.
		const fingerprint = cdk.FileSystem.fingerprint(props.dataDir, {
			exclude: LOCAL_ARTIFACTS,
		});
		const startIngestion: cr.AwsSdkCall = {
			service: "bedrock-agent",
			action: "StartIngestionJob",
			parameters: {
				knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
				dataSourceId: this.dataSource.attrDataSourceId,
				description: `files ${fingerprint.slice(0, 16)}, max ${props.maxFileSizeMb} MB`,
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
					resources: [this.knowledgeBase.attrKnowledgeBaseArn],
				}),
			]),
			logGroup: awsCustomResourceLogGroup(this),
		});
		ingestion.node.addDependency(this.dataSource);

		const outputs: Record<string, string> = {
			KnowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
			DataSourceId: this.dataSource.attrDataSourceId,
			BucketName: this.bucket.bucketName,
			DocumentPrefix: DOCUMENT_PREFIX,
		};
		for (const [outputName, value] of Object.entries(outputs)) {
			new cdk.CfnOutput(this, outputName, { value });
		}

		addAutoDeleteObjectsLogGroup(this);
		deleteLogGroupsAfterRoles(this);
		addNagSuppressions(this);
	}
}
