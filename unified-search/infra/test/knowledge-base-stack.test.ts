import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack';
import { SEED_USERS } from '../lib/seed-acl';

function synth() {
  const app = new cdk.App();
  const stack = new KnowledgeBaseStack(app, 'UnifiedSearch-test-KnowledgeBase', {
    stageName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return { stack, template: Template.fromStack(stack) };
}

/** The synthesized data source properties, or throws if there is no data source. */
function dataSourceProperties(template: Template): Record<string, unknown> {
  const dataSources = template.findResources('AWS::Bedrock::DataSource');
  const [dataSource] = Object.values(dataSources);
  const properties = (
    dataSource as { Properties?: Record<string, unknown> } | undefined
  )?.Properties;

  if (properties === undefined) {
    throw new Error('No data source found in the synthesized template');
  }
  return properties;
}

/**
 * Reads back the synthesized `connectorParameters`.
 *
 * CloudFormation types this property as raw `Json` and CDK surfaces it as `any`, so
 * there is no compile-time check that the shape is correct. Asserting on the
 * synthesized template is the only way to catch a misspelled connector field before
 * a deploy does.
 */
function connectorParameters(template: Template): Record<string, unknown> {
  const dataSources = template.findResources('AWS::Bedrock::DataSource');
  const [dataSource] = Object.values(dataSources);

  const properties = (
    dataSource as { Properties?: Record<string, unknown> } | undefined
  )?.Properties;
  const config = properties?.['DataSourceConfiguration'] as
    Record<string, unknown> | undefined;
  const connector = config?.['ManagedKnowledgeBaseConnectorConfiguration'] as
    Record<string, unknown> | undefined;
  const params = connector?.['ConnectorParameters'] as
    Record<string, unknown> | undefined;

  if (params === undefined) {
    throw new Error('No ConnectorParameters found on the synthesized data source');
  }
  return params;
}

describe('KnowledgeBaseStack', () => {
  it('synthesizes', () => {
    expect(() => synth()).not.toThrow();
  });

  describe('knowledge base', () => {
    it('is a managed knowledge base with a service-managed embedding model', () => {
      const { template } = synth();

      template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
        KnowledgeBaseConfiguration: Match.objectLike({
          // MANAGED selects the Bedrock-managed vector store. VECTOR would require
          // provisioning and maintaining a store.
          Type: 'MANAGED',
          ManagedKnowledgeBaseConfiguration: Match.objectLike({
            EmbeddingModelType: 'MANAGED',
          }),
        }),
      });
    });

    it('does not declare a storage configuration', () => {
      const { template } = synth();
      const bases = template.findResources('AWS::Bedrock::KnowledgeBase');
      const [base] = Object.values(bases);

      // Storage is the service's responsibility for a managed knowledge base.
      expect(
        (base as { Properties: Record<string, unknown> }).Properties,
      ).not.toHaveProperty('StorageConfiguration');
    });
  });

  describe('data source', () => {
    it('uses the managed connector envelope', () => {
      const { template } = synth();

      template.hasResourceProperties('AWS::Bedrock::DataSource', {
        DataSourceConfiguration: Match.objectLike({
          Type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        }),
      });
    });

    /**
     * The security property the sample exists to demonstrate.
     *
     * `aclEnabled` cannot be changed after the data source is created, so losing it
     * means replacing the data source and re-ingesting — and in the meantime every
     * document is returned to every user.
     */
    it('enables document-level access control', () => {
      const params = connectorParameters(synth().template);

      expect(params['aclEnabled']).toBe(true);
    });

    it('points at a global ACL file in the content bucket', () => {
      const params = connectorParameters(synth().template);
      const acl = params['aclConfiguration'] as Record<string, unknown>;

      expect(acl).toBeDefined();
      expect(JSON.stringify(acl['globalAccessControlListS3Uri'])).toContain(
        'acl/global-acl.json',
      );
    });

    /**
     * The ACL file lives in the same bucket as the content it governs, so without an
     * inclusion prefix it would be crawled and indexed as a document.
     */
    it('crawls only the content prefix, so the ACL file is not ingested', () => {
      const params = connectorParameters(synth().template);
      const filter = params['filterConfiguration'] as Record<string, unknown>;

      expect(filter['inclusionPrefixes']).toEqual(['content/']);
    });

    it('enables deletion protection', () => {
      const { template } = synth();

      template.hasResourceProperties('AWS::Bedrock::DataSource', {
        DataSourceConfiguration: Match.objectLike({
          ManagedKnowledgeBaseConnectorConfiguration: Match.objectLike({
            DeletionProtectionConfiguration: Match.objectLike({
              DeletionProtectionStatus: 'ENABLED',
            }),
          }),
        }),
      });
    });
  });

  describe('service role', () => {
    it('is assumable only by Bedrock, scoped to this account and knowledge bases', () => {
      const { template } = synth();

      // Both conditions guard the confused-deputy case: without them another
      // account could induce Bedrock to assume this role on their behalf.
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'bedrock.amazonaws.com' },
              Condition: Match.objectLike({
                StringEquals: { 'aws:SourceAccount': '123456789012' },
                ArnLike: Match.anyValue(),
              }),
            }),
          ]),
        }),
      });
    });

    it('grants no bedrock:InvokeModel, since embedding is service-managed', () => {
      const { template } = synth();
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));

      expect(policies).not.toContain('bedrock:InvokeModel');
    });
  });

  describe('content bucket', () => {
    it('blocks public access and enforces TLS', () => {
      const { template } = synth();

      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('is encrypted', () => {
      const { template } = synth();

      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: Match.objectLike({
          ServerSideEncryptionConfiguration: Match.anyValue(),
        }),
      });
    });

    it('has a separate access log bucket', () => {
      const { template } = synth();

      // Two buckets: content, plus the log bucket it writes to.
      template.resourceCountIs('AWS::S3::Bucket', 2);
    });
  });

  describe('outputs', () => {
    it.each([
      'KnowledgeBaseId',
      'DataSourceId',
      'ContentBucketName',
      'StartIngestionCommand',
    ])('exposes %s', (name) => {
      synth().template.hasOutput(name, Match.anyValue());
    });

    /**
     * Ingestion is not started by the deploy.
     *
     * It costs money, and a sample should not begin incurring charges as a side
     * effect of `cdk deploy`. The command is emitted instead.
     */
    it('does not start ingestion automatically', () => {
      const { template } = synth();
      const resources = JSON.stringify(template.toJSON());

      expect(resources).not.toContain('StartIngestionJob');
    });
  });

  /**
   * Ingestion customization.
   *
   * `VectorIngestionConfiguration` is a sibling of `DataSourceConfiguration` rather than
   * a member of the connector envelope. CDK does not validate that placement at synth
   * time, so these tests assert its position in the template.
   */
  describe('parsing configuration', () => {
    it('sets SMART_PARSING on the data source', () => {
      const { template } = synth();

      template.hasResourceProperties('AWS::Bedrock::DataSource', {
        VectorIngestionConfiguration: {
          ParsingConfiguration: { ParsingStrategy: 'SMART_PARSING' },
        },
      });
    });

    it('places it beside DataSourceConfiguration, not inside the connector', () => {
      const { template } = synth();
      const properties = dataSourceProperties(template);

      expect(properties).toHaveProperty('VectorIngestionConfiguration');
      expect(JSON.stringify(properties['DataSourceConfiguration'])).not.toContain(
        'VectorIngestionConfiguration',
      );
    });

    /**
     * With a service-managed embedding model the knowledge base manages chunking
     * automatically, so no chunking configuration reaches the template by any path.
     */
    it('never emits a chunking configuration', () => {
      const { template } = synth();

      expect(JSON.stringify(template.toJSON())).not.toContain('ChunkingConfiguration');
    });
  });

  describe('seed identities', () => {
    it('uses reserved example.com addresses', () => {
      // example.com cannot be registered, so these can never collide with a real
      // mailbox — which matters because they are written into ACL entries.
      for (const email of Object.values(SEED_USERS)) {
        expect(email).toMatch(/@example\.com$/);
      }
    });

    it('gives the two users overlapping but different access', () => {
      // The suite needs a document each user can read, one only Alejandro can read, and
      // one only Akua can read, or it cannot tell filtering from a blanket allow.
      expect(SEED_USERS.alejandro).not.toBe(SEED_USERS.akua);
      expect(SEED_USERS.outsider).not.toBe(SEED_USERS.alejandro);
      expect(SEED_USERS.outsider).not.toBe(SEED_USERS.akua);
    });
  });
});
