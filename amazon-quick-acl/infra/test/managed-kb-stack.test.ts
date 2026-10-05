import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { GLOBAL_ACL_KEY, ManagedKbStack } from '../lib/managed-kb-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function synth(aclEnabled?: boolean): Template {
  const app = new App();
  const stack = new ManagedKbStack(app, 'TestStack', {
    env,
    kbName: 'test-kb',
    aclEnabled,
  });
  return Template.fromStack(stack);
}

function connectorParameters(template: Template): Record<string, unknown> {
  const sources = template.findResources('AWS::Bedrock::DataSource');
  const [source] = Object.values(sources);
  if (!source) throw new Error('No AWS::Bedrock::DataSource in the template');
  return source.Properties.DataSourceConfiguration
    .ManagedKnowledgeBaseConnectorConfiguration.ConnectorParameters;
}

describe('ManagedKbStack', () => {
  it('creates a managed knowledge base with no storage configuration', () => {
    const template = synth();

    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      Name: 'test-kb',
      KnowledgeBaseConfiguration: {
        Type: 'MANAGED',
        ManagedKnowledgeBaseConfiguration: {},
      },
      StorageConfiguration: Match.absent(),
    });
  });

  it('enables ACLs on the S3 data source by default, reading the in-bucket ACL file', () => {
    const params = connectorParameters(synth());

    expect(params.type).toBe('S3');
    expect(params.aclEnabled).toBe(true);
    const uri = JSON.stringify(params.aclConfiguration);
    expect(uri).toContain(GLOBAL_ACL_KEY);
  });

  it('omits ACL configuration entirely when ACLs are disabled', () => {
    const params = connectorParameters(synth(false));

    expect(params).not.toHaveProperty('aclEnabled');
    expect(params).not.toHaveProperty('aclConfiguration');
  });

  it('grants the service role read access to the bucket and nothing on Bedrock models', () => {
    const template = synth();
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));

    expect(policies).toContain('s3:GetObject');
    expect(policies).toContain('s3:ListBucket');
    expect(policies).not.toContain('bedrock:InvokeModel');
  });

  it('retains both buckets so destroy cannot delete source documents', () => {
    const template = synth();
    const buckets = template.findResources('AWS::S3::Bucket');

    expect(Object.keys(buckets)).toHaveLength(2);
    for (const bucket of Object.values(buckets)) {
      expect(bucket.DeletionPolicy).toBe('Retain');
    }
  });

  it('sends the data bucket access logs to the access logs bucket', () => {
    // cdk-nag S1 is acknowledged for the access logs bucket only, so synth would catch
    // this too. The test keeps the guarantee independent of the acknowledgment scope.
    const template = synth();

    template.hasResourceProperties('AWS::S3::Bucket', {
      LoggingConfiguration: {
        DestinationBucketName: { Ref: Match.stringLikeRegexp('^AccessLogsBucket') },
        LogFilePrefix: 'knowledge-base-data/',
      },
    });
  });

  it('outputs the bare data source ID, not the compound Ref', () => {
    const template = synth();

    template.hasOutput('S3DataSourceId', {
      Value: { 'Fn::Select': [1, { 'Fn::Split': ['|', Match.anyValue()] }] },
    });
  });

  it('points readers at the console path the README uses', () => {
    synth().hasOutput('KnowledgeBaseArn', {
      Description: Match.stringLikeRegexp('More > Knowledge'),
    });
  });
});
