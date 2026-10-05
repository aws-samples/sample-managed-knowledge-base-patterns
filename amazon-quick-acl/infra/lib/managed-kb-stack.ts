import {
  CfnOutput,
  CfnResource,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
  Validations,
} from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Relative key of the global ACL file inside the data bucket. Bedrock requires the ACL
 * configuration to live in the same bucket as the content it describes.
 */
export const GLOBAL_ACL_KEY = 'acl/global-acl.json';

export interface ManagedKbStackProps extends StackProps {
  readonly kbName: string;
  /** Defaults to true. Turning it off removes the per-user filtering the demo shows. */
  readonly aclEnabled?: boolean;
}

/**
 * Provisions an Amazon Bedrock *managed* knowledge base (Bedrock owns the vector store,
 * embedding model and reranker) with an Amazon S3 data source that has document-level ACL
 * awareness enabled.
 *
 * The ACLs are what let Amazon Quick return different results to different users without
 * any auth code in the application: Quick forwards the signed-in user's identity to
 * Bedrock, and Bedrock filters retrieval results against the ACL file below.
 *
 * The Bedrock resources are declared with raw CfnResource escape hatches rather than the
 * typed L1 constructs. Managed knowledge bases are a recent addition to CloudFormation and
 * `ConnectorParameters` is an opaque JSON blob either way, so raw resources keep this
 * stack working across aws-cdk-lib versions instead of tracking a specific one.
 */
export class ManagedKbStack extends Stack {
  constructor(scope: Construct, id: string, props: ManagedKbStackProps) {
    super(scope, id, props);

    const { kbName, aclEnabled = true } = props;

    // ---------------------------------------------------------------------------
    // Data bucket
    // ---------------------------------------------------------------------------

    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Acknowledged on this bucket only, not at stack scope. A stack-scope acknowledgment
    // would also cover the data bucket, so removing its access logging would pass synth.
    Validations.of(accessLogsBucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason:
        'This is the server access logs bucket. Logging it to itself would create a ' +
        'recursive logging loop.',
    });

    const dataBucket = new s3.Bucket(this, 'KnowledgeBaseDataBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'knowledge-base-data/',
      // RETAIN so that `cdk destroy` never silently deletes ingested source documents.
      // Empty and delete the bucket by hand if you want it gone.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------------------
    // Knowledge base service role
    //
    // Managed knowledge bases use service-managed embedding and reranking models by
    // default, so this role needs no bedrock:InvokeModel permissions - only read access
    // to the data bucket.
    // ---------------------------------------------------------------------------

    const kbRole = new iam.Role(this, 'KnowledgeBaseServiceRole', {
      description:
        'Service role assumed by Amazon Bedrock to ingest and retrieve knowledge base content',
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:${this.partition}:bedrock:${this.region}:${this.account}:knowledge-base/*`,
          },
        },
      }),
    });

    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ListBucketStatement',
        actions: ['s3:ListBucket'],
        resources: [dataBucket.bucketArn],
        conditions: { StringEquals: { 'aws:ResourceAccount': this.account } },
      }),
    );

    kbRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3GetObjectStatement',
        actions: ['s3:GetObject'],
        resources: [dataBucket.arnForObjects('*')],
        conditions: { StringEquals: { 'aws:ResourceAccount': this.account } },
      }),
    );

    // ---------------------------------------------------------------------------
    // Managed knowledge base
    // ---------------------------------------------------------------------------

    const knowledgeBase = new CfnResource(this, 'ManagedKnowledgeBase', {
      type: 'AWS::Bedrock::KnowledgeBase',
      properties: {
        Name: kbName,
        Description:
          'Managed knowledge base consumed by Amazon Quick as a knowledge source',
        RoleArn: kbRole.roleArn,
        KnowledgeBaseConfiguration: {
          // MANAGED (not VECTOR) is what makes this a managed knowledge base.
          Type: 'MANAGED',
          // Empty object accepts the service-managed embedding model, reranker and
          // encryption defaults. Add EmbeddingModelArn / ServerSideEncryptionConfiguration
          // here to override them.
          ManagedKnowledgeBaseConfiguration: {},
        },
        // StorageConfiguration is deliberately omitted - Bedrock owns the vector store
        // for a managed knowledge base.
      },
    });

    knowledgeBase.node.addDependency(kbRole);

    const knowledgeBaseId = knowledgeBase.ref;
    const knowledgeBaseArn = knowledgeBase.getAtt('KnowledgeBaseArn').toString();

    // ---------------------------------------------------------------------------
    // Amazon S3 data source (ACL aware)
    // ---------------------------------------------------------------------------

    const s3ConnectorParameters: Record<string, unknown> = {
      type: 'S3',
      version: '1',
      connectionConfiguration: {
        bucketName: dataBucket.bucketName,
        bucketOwnerAccountId: this.account,
      },
      filterConfiguration: {
        maxFileSizeInMegaBytes: '50',
      },
    };

    if (aclEnabled) {
      // With ACL awareness on, a document with no ACL entry is NOT ingested: it is
      // treated as restricted, not public, and counted as a failed document in the
      // ingestion job. Every prefix that holds content must therefore appear in the
      // global ACL file, or carry a per-document <filename>.metadata.json alongside it.
      // A missing global ACL file fails the whole ingestion job.
      s3ConnectorParameters.aclEnabled = true;
      s3ConnectorParameters.aclConfiguration = {
        globalAccessControlListS3Uri: `s3://${dataBucket.bucketName}/${GLOBAL_ACL_KEY}`,
      };
    }

    const s3DataSource = new CfnResource(this, 'S3DataSource', {
      type: 'AWS::Bedrock::DataSource',
      properties: {
        KnowledgeBaseId: knowledgeBaseId,
        Name: `${kbName}-s3`,
        Description: 'Amazon S3 documents with document-level access control',
        DataSourceConfiguration: {
          Type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
          ManagedKnowledgeBaseConnectorConfiguration: {
            ConnectorParameters: s3ConnectorParameters,
          },
        },
      },
    });

    // ---------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------

    new CfnOutput(this, 'KnowledgeBaseArn', {
      value: knowledgeBaseArn,
      description:
        'Paste this into Amazon Quick under Admin > Manage Account > AWS Resources, then create a knowledge base under More > Knowledge',
    });

    new CfnOutput(this, 'KnowledgeBaseId', {
      value: knowledgeBaseId,
      description: 'Knowledge base ID, used when starting an ingestion job',
    });

    new CfnOutput(this, 'DataBucketName', {
      value: dataBucket.bucketName,
      description: 'Upload source documents and the ACL file here',
    });

    new CfnOutput(this, 'GlobalAclS3Uri', {
      value: `s3://${dataBucket.bucketName}/${GLOBAL_ACL_KEY}`,
      description: 'Location the S3 data source reads document ACLs from',
    });

    new CfnOutput(this, 'S3DataSourceId', {
      // `Ref` on AWS::Bedrock::DataSource returns the compound identifier
      // "<knowledgeBaseId>|<dataSourceId>", but every API and CLI call wants the bare
      // data source ID. Split it here so the output can be pasted straight into
      // `aws bedrock-agent start-ingestion-job --data-source-id`.
      value: Fn.select(1, Fn.split('|', s3DataSource.ref)),
      description: 'Pass to start-ingestion-job to sync the S3 data source',
    });
  }
}
