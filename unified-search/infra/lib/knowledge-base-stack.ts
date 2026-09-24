import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import type { Construct } from 'constructs';
import { buildS3ConnectorParameters } from './s3-connector-params';
import { CONTENT_PREFIX, GLOBAL_ACL_KEY } from './seed-acl';

export interface KnowledgeBaseStackProps extends cdk.StackProps {
  readonly stageName: string;
}

/**
 * A managed Bedrock knowledge base with an ACL-enabled Amazon S3 data source.
 *
 * Deployed only in `sample` mode. In `byo` mode this stack is not instantiated at
 * all, so nothing here can touch a knowledge base the operator owns.
 *
 * ## Costs
 *
 * A knowledge base incurs ingestion and storage charges for as long as it exists.
 * `cdk destroy` removes it along with the content bucket, which is right for a
 * sample holding synthetic documents and would be wrong for real data.
 *
 * ## Why content is uploaded by a script rather than by this stack
 *
 * `s3deploy.BucketDeployment` provisions a Lambda-backed custom resource whose
 * execution role uses an AWS managed policy and broad S3 permissions, which
 * cdk-nag reports. Because this sample demonstrates least privilege, sample data
 * is seeded separately rather than through that construct.
 *
 * `npm run seed:sample` uploads the documents and the generated ACL file instead.
 *
 * ## Why the access control lists are declared outside this file
 *
 * Amazon S3 access is governed by IAM and bucket policies rather than per-user
 * document permissions, so ACLs are customer-provided: a JSON file mapping key
 * prefixes to entries, stored in the same bucket as the content. Two consequences shape this stack:
 *
 * 1. With `aclEnabled`, a document with no matching ACL entry is **not ingested at
 *    all** — not merely hidden from queries. So the ACL file and the uploaded
 *    prefixes have to agree, which is why both derive from `seed-acl.ts`.
 * 2. The ACL file must not itself be ingested, so the crawl is restricted to
 *    `content/`.
 */
export class KnowledgeBaseStack extends cdk.Stack {
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseArn: string;
  readonly dataSourceId: string;
  readonly contentBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props);

    // Access logs need their own bucket; a bucket cannot log to itself.
    const logBucket = new s3.Bucket(this, 'ContentAccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const contentBucket = new s3.Bucket(this, 'Content', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'content-bucket/',
      // Appropriate for a sample holding synthetic documents. Real corpora belong
      // in `byo` mode, where this stack is never deployed.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.contentBucket = contentBucket;

    /**
     * Service role the knowledge base assumes to read the bucket.
     *
     * The trust policy is conditioned on both `aws:SourceAccount` and an `ArnLike`
     * on `aws:SourceArn`, so another account cannot induce Bedrock to assume this
     * role on their behalf — the confused-deputy case.
     *
     * A managed knowledge base uses service-managed embedding and reranking models
     * by default, so no `bedrock:InvokeModel` grant is needed.
     */
    const serviceRole = new iam.Role(this, 'KnowledgeBaseServiceRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': this.formatArn({
              service: 'bedrock',
              resource: 'knowledge-base',
              resourceName: '*',
            }),
          },
        },
      }),
      description:
        'Read access to the sample content bucket for the managed knowledge base',
    });

    /**
     * Read permissions, written explicitly rather than via `bucket.grantRead()`.
     *
     * `grantRead` is convenient but broader than this role needs: it expands to
     * `s3:GetObject*`, `s3:GetBucket*`, and `s3:List*`. The documented minimum for
     * an S3 data source is `s3:ListBucket` on the bucket and `s3:GetObject` on its
     * objects, so that is what is granted. Being specific removes three wildcard
     * findings and, more to the point, means the role cannot read bucket
     * configuration or object versions it has no need for.
     */
    serviceRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ListSampleContentBucket',
        actions: ['s3:ListBucket'],
        resources: [contentBucket.bucketArn],
      }),
    );
    serviceRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadSampleContentObjects',
        actions: ['s3:GetObject'],
        resources: [contentBucket.arnForObjects('*')],
      }),
    );

    /**
     * The object-level wildcard is irreducible.
     *
     * A crawler must read objects whose keys are not known when the policy is
     * written, and IAM has no way to express "every object under this bucket"
     * without `/*`. The grant is still bounded on both axes that matter: exactly
     * one action, and one bucket that this stack owns and whose only contents are
     * synthetic sample documents.
     */
    // The finding ID embeds the bucket's generated logical ID, so renaming the
    // `Content` construct invalidates this acknowledgment and synth fails until it
    // is updated. This is intentional: a changed policy should be re-reviewed rather
    // than inheriting an old justification. A test in
    // test/cdk-nag.test.ts asserts sample mode still synthesizes, so the drift
    // surfaces in CI rather than on someone's first deploy.
    cdk.Validations.of(serviceRole).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::<Content88381566.Arn>/*]',
      reason:
        'A data source crawler must read objects whose keys are unknown at policy-authoring ' +
        'time, and IAM cannot express object-level access without a wildcard. Scoped to ' +
        's3:GetObject on a single stack-owned bucket containing only synthetic sample content.',
    });

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `unified-search-${props.stageName}-${this.account}`,
      roleArn: serviceRole.roleArn,
      description: 'Sample knowledge base for unified-search',
      knowledgeBaseConfiguration: {
        // MANAGED selects a vector store fully managed by Bedrock. The
        // alternatives are VECTOR (bring your own store), KENDRA, and SQL.
        type: 'MANAGED',
        managedKnowledgeBaseConfiguration: {
          // A service-managed embedding model: no embedding model to select or
          // request access to.
          embeddingModelType: 'MANAGED',
        },
      },
    });
    knowledgeBase.node.addDependency(serviceRole);

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
    this.knowledgeBaseArn = knowledgeBase.attrKnowledgeBaseArn;

    const dataSource = new bedrock.CfnDataSource(this, 'S3DataSource', {
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      name: 'sample-s3-content',
      description: 'ACL-enabled S3 data source over the sample content bucket',
      /**
       * Ingestion-time customization.
       *
       * Smart Parsing is the parsing strategy for a managed knowledge base: it selects
       * a parser per document type. It is also what the service uses when this block is
       * omitted, so it is set here to show where the setting lives rather than to
       * change behavior.
       *
       * `vectorIngestionConfiguration` is a sibling of `dataSourceConfiguration`, not a
       * member of the connector envelope that holds the other data-source settings.
       * CDK does not validate that placement at synth time, so a unit test covers it.
       *
       * Chunking is not set: with a service-managed embedding model the knowledge base
       * manages chunking automatically.
       */
      vectorIngestionConfiguration: {
        parsingConfiguration: { parsingStrategy: 'SMART_PARSING' },
      },
      dataSourceConfiguration: {
        type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        managedKnowledgeBaseConnectorConfiguration: {
          connectorParameters: buildS3ConnectorParameters({
            bucketName: contentBucket.bucketName,
            bucketOwnerAccountId: this.account,
            aclEnabled: true,
            globalAclS3Uri: `s3://${contentBucket.bucketName}/${GLOBAL_ACL_KEY}`,
            // Without this the ACL file, which shares the bucket, would be
            // ingested as a document.
            inclusionPrefixes: [CONTENT_PREFIX],
          }),
          deletionProtectionConfiguration: {
            deletionProtectionStatus: 'ENABLED',
            deletionProtectionThreshold: 15,
          },
        },
      },
    });
    this.dataSourceId = dataSource.attrDataSourceId;

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: knowledgeBase.attrKnowledgeBaseId,
      description: 'Pass to the backend as KNOWLEDGE_BASE_ID',
    });
    new cdk.CfnOutput(this, 'DataSourceId', {
      value: dataSource.attrDataSourceId,
      description: 'Data source ID, for ingestion and ACL debugging',
    });
    new cdk.CfnOutput(this, 'ContentBucketName', {
      value: contentBucket.bucketName,
      description: 'Target for npm run seed:sample',
    });
    new cdk.CfnOutput(this, 'StartIngestionCommand', {
      // Ingestion is not started by the deploy: it costs money, and a sample
      // should not begin incurring charges as a side effect of `cdk deploy`.
      value: [
        'aws bedrock-agent start-ingestion-job',
        `--knowledge-base-id ${knowledgeBase.attrKnowledgeBaseId}`,
        `--data-source-id ${dataSource.attrDataSourceId}`,
      ].join(' '),
      description: 'Run after seeding to index the documents',
    });
  }
}
