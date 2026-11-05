import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct, IDependable } from 'constructs';
import { awsCustomResourceLogGroup } from '../log-groups';
import { acknowledgeServiceRole } from '../nag-acknowledgments';

export interface ManagedKnowledgeBaseProps {
  readonly name: string;
  readonly description: string;
  readonly dataSourceName: string;
  readonly dataSourceDescription: string;
  readonly bucket: s3.IBucket;
  /** Key prefixes the data source indexes. The service role reads only these. */
  readonly inclusionPrefixes: readonly string[];
  /** Changes with the corpus, so a deploy after a corpus change re-ingests. */
  readonly corpusFingerprint: string;
  /** The corpus upload. The data source and the ingestion job wait for it. */
  readonly deployment: IDependable;
}

/**
 * A managed knowledge base with an S3 data source and its own service role, plus an
 * ingestion job started on every deploy that changes the corpus. ACLs are off: tenant
 * isolation in this sample comes from metadata filters built on the server.
 */
export class ManagedKnowledgeBase extends Construct {
  readonly knowledgeBaseId: string;
  readonly knowledgeBaseArn: string;
  readonly dataSourceId: string;
  readonly serviceRole: iam.Role;

  constructor(scope: Construct, id: string, props: ManagedKnowledgeBaseProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const account = stack.account;
    const sameAccount = { StringEquals: { 'aws:ResourceAccount': account } };

    // The knowledge base ARN isn't known before the role exists, so the trust names
    // every knowledge base in this account and Region.
    this.serviceRole = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: {
            'aws:SourceArn': stack.formatArn({
              service: 'bedrock',
              resource: 'knowledge-base',
              resourceName: '*',
            }),
          },
        },
      }),
    });
    // Explicit statements instead of grantRead, which adds s3:GetObject*,
    // s3:GetBucket*, and s3:List*.
    this.serviceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListCorpusBucket',
        actions: ['s3:ListBucket'],
        resources: [props.bucket.bucketArn],
        conditions: sameAccount,
      }),
    );
    this.serviceRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCorpusObjects',
        actions: ['s3:GetObject'],
        resources: props.inclusionPrefixes.map((prefix) =>
          props.bucket.arnForObjects(`${prefix}*`),
        ),
        conditions: sameAccount,
      }),
    );
    acknowledgeServiceRole(this.serviceRole, props.inclusionPrefixes);

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'Resource', {
      name: props.name,
      description: props.description,
      roleArn: this.serviceRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'MANAGED',
        managedKnowledgeBaseConfiguration: { embeddingModelType: 'MANAGED' },
      },
    });
    // Wait for the role's policy too, not only the role.
    knowledgeBase.node.addDependency(this.serviceRole);
    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
    this.knowledgeBaseArn = knowledgeBase.attrKnowledgeBaseArn;

    const dataSource = new bedrock.CfnDataSource(this, 'DataSource', {
      name: props.dataSourceName,
      description: props.dataSourceDescription,
      knowledgeBaseId: this.knowledgeBaseId,
      dataDeletionPolicy: 'DELETE',
      dataSourceConfiguration: {
        type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        managedKnowledgeBaseConnectorConfiguration: {
          connectorParameters: {
            type: 'S3',
            version: '1',
            // Isolation comes from metadata filters, not from userContext ACLs.
            aclEnabled: false,
            connectionConfiguration: {
              bucketName: props.bucket.bucketName,
              bucketOwnerAccountId: account,
            },
            filterConfiguration: { inclusionPrefixes: [...props.inclusionPrefixes] },
          },
        },
      },
    });
    dataSource.node.addDependency(props.deployment);
    this.dataSourceId = dataSource.attrDataSourceId;

    // Start ingestion on deploy. The deploy doesn't wait for the job to finish;
    // `ri-sample status --wait` does.
    const startIngestion: cr.AwsSdkCall = {
      service: 'bedrock-agent',
      action: 'StartIngestionJob',
      parameters: {
        knowledgeBaseId: this.knowledgeBaseId,
        dataSourceId: this.dataSourceId,
        description: `corpus ${props.corpusFingerprint}`,
      },
      physicalResourceId: cr.PhysicalResourceId.fromResponse(
        'ingestionJob.ingestionJobId',
      ),
    };
    const ingestion = new cr.AwsCustomResource(this, 'StartIngestion', {
      onCreate: startIngestion,
      onUpdate: startIngestion,
      // The SDK client name (bedrock-agent) differs from the IAM prefix (bedrock).
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['bedrock:StartIngestionJob'],
          resources: [this.knowledgeBaseArn],
        }),
      ]),
      installLatestAwsSdk: false,
      logGroup: awsCustomResourceLogGroup(this),
    });
    ingestion.node.addDependency(dataSource);
    ingestion.node.addDependency(props.deployment);
  }
}
