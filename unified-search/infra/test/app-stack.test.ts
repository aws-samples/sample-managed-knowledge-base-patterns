import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';

function synth(knowledgeBaseId = 'ABCDE12345', stageName = 'test') {
  const app = new cdk.App();
  const stack = new AppStack(app, `UnifiedSearch-${stageName}-App`, {
    stageName,
    knowledgeBaseId,
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return { app, stack, template: Template.fromStack(stack) };
}

describe('AppStack', () => {
  it('synthesizes', () => {
    expect(() => synth()).not.toThrow();
  });

  it('reports the stage it was synthesized for', () => {
    const { template } = synth('ABCDE12345', 'staging');
    template.hasOutput('StageName', Match.objectLike({ Value: 'staging' }));
  });

  it('exposes the knowledge base ID for the backend', () => {
    const { template } = synth();
    template.hasOutput('KnowledgeBaseId', Match.objectLike({ Value: 'ABCDE12345' }));
  });

  /**
   * In `byo` mode the operator's knowledge base must not be a CDK resource.
   *
   * Not an imported construct and not a custom resource — just an ID. If it were
   * modeled, a future change could reconfigure or delete something the operator
   * owns, and `cdk destroy` becomes dangerous rather than merely tidy.
   */
  it('declares no Bedrock resources of its own', () => {
    const { template } = synth();

    template.resourceCountIs('AWS::Bedrock::KnowledgeBase', 0);
    template.resourceCountIs('AWS::Bedrock::DataSource', 0);
  });

  it('builds the knowledge base ARN from the supplied ID', () => {
    const { stack } = synth();

    // The partition stays an unresolved token rather than a literal `aws`, which
    // is what lets the same stack deploy into aws-cn and aws-us-gov. So this
    // asserts the parts that are ours to get right and tolerates the token.
    expect(stack.knowledgeBaseArn).toContain(
      ':bedrock:us-east-1:123456789012:knowledge-base/ABCDE12345',
    );
    expect(stack.knowledgeBaseArn).not.toContain('arn:aws:');
  });

  describe('grantRetrieve', () => {
    function grantTo() {
      const app = new cdk.App();
      const stack = new AppStack(app, 'UnifiedSearch-test-App', {
        stageName: 'test',
        knowledgeBaseId: 'ABCDE12345',
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const role = new iam.Role(stack, 'Consumer', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      stack.grantRetrieve(role);
      return Template.fromStack(stack);
    }

    /**
     * `Retrieve` is resource-scoped; `AgenticRetrieveStream` cannot be.
     *
     * `bedrock:AgenticRetrieveStream` does not support resource-level permissions, so
     * it is granted on `*` in its own statement, and `Retrieve` stays scoped to the
     * knowledge base ARN.
     */
    it('scopes bedrock:Retrieve to one knowledge base ARN', () => {
      grantTo().hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['bedrock:Retrieve', 'bedrock:GetDocumentContent'],
              Effect: 'Allow',
              Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
            }),
          ]),
        }),
      });

      expect(JSON.stringify(grantTo().findResources('AWS::IAM::Policy'))).toContain(
        'knowledge-base/ABCDE12345',
      );
    });

    /**
     * Document fetch authorizes two actions, and both are resource-scopable.
     *
     * Reading document content requires `bedrock:Retrieve` as well as
     * `bedrock:GetDocumentContent` on the knowledge base ARN. Both support
     * resource-level permissions, so unlike `AgenticRetrieveStream`, neither needs a
     * wildcard.
     */
    it('scopes bedrock:GetDocumentContent to the knowledge base, not *', () => {
      const wildcarded = Object.values(grantTo().findResources('AWS::IAM::Policy'))
        .flatMap((policy) => {
          const document = (
            policy.Properties as {
              PolicyDocument?: { Statement?: readonly Record<string, unknown>[] };
            }
          ).PolicyDocument;
          return document?.Statement ?? [];
        })
        .filter((statement) => statement.Resource === '*')
        .flatMap((statement) =>
          Array.isArray(statement.Action) ? statement.Action : [statement.Action],
        );

      expect(wildcarded).not.toContain('bedrock:GetDocumentContent');
    });

    it('grants bedrock:AgenticRetrieveStream on *, as it has no resource-level permissions', () => {
      grantTo().hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'bedrock:AgenticRetrieveStream',
              Effect: 'Allow',
              Resource: '*',
            }),
          ]),
        }),
      });
    });

    /**
     * The wildcard above is on exactly one read-only action. A task role holding
     * `bedrock:*`, `s3:*`, or `sts:AssumeRole` on `Resource: '*'` is the thing
     * this test exists to keep out.
     */
    it('grants no service-wide wildcards', () => {
      const policies = JSON.stringify(grantTo().findResources('AWS::IAM::Policy'));

      expect(policies).not.toContain('bedrock:*');
      expect(policies).not.toContain('"Action":"*"');
      // RetrieveAndGenerate is not supported on a managed knowledge base; chat uses
      // AgenticRetrieveStream instead, so RetrieveAndGenerate is not granted.
      expect(policies).not.toContain('RetrieveAndGenerate');
    });

    it('puts the wildcard only on AgenticRetrieveStream', () => {
      const statements = Object.values(grantTo().findResources('AWS::IAM::Policy'))
        .flatMap((policy) => {
          const document = (
            policy.Properties as {
              PolicyDocument?: { Statement?: readonly Record<string, unknown>[] };
            }
          ).PolicyDocument;
          return document?.Statement ?? [];
        })
        .filter((statement) => statement.Resource === '*');

      // If a future change collapses both actions onto `*` for tidiness, this fails.
      expect(statements.map((statement) => statement.Action)).toEqual([
        'bedrock:AgenticRetrieveStream',
      ]);
    });

    it('grants no write or management actions', () => {
      const policies = JSON.stringify(grantTo().findResources('AWS::IAM::Policy'));

      // The application cannot start an ingestion job, alter a data source, or
      // delete the knowledge base.
      for (const forbidden of [
        'StartIngestionJob',
        'DeleteKnowledgeBase',
        'UpdateDataSource',
        'CreateDataSource',
        'DeleteDataSource',
      ]) {
        expect(policies).not.toContain(forbidden);
      }
    });

    /**
     * ACL debugging discloses who may read a given document, so it is granted
     * separately from ordinary retrieval and belongs to an administrative surface.
     */
    it('does not include the ACL diagnostics actions', () => {
      const policies = JSON.stringify(grantTo().findResources('AWS::IAM::Policy'));

      expect(policies).not.toContain('CheckIngestedDocumentAcl');
      expect(policies).not.toContain('GetIngestedDocumentAcl');
    });
  });

  describe('grantConversationMemory', () => {
    function stackWith(memoryArn?: string) {
      const app = new cdk.App();
      const stack = new AppStack(app, 'UnifiedSearch-test-App', {
        stageName: 'test',
        knowledgeBaseId: 'ABCDE12345',
        ...(memoryArn === undefined ? {} : { memoryArn }),
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const role = new iam.Role(stack, 'Consumer', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      return { stack, role };
    }

    const MEMORY_ARN =
      'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/unified_search_test';

    it('grants nothing when no memory resource is deployed', () => {
      const { stack, role } = stackWith();

      // A deployment without memory should hold no memory permissions at all,
      // rather than holding them against a wildcard resource.
      expect(stack.grantConversationMemory(role)).toBeUndefined();
      const policies = JSON.stringify(
        Template.fromStack(stack).findResources('AWS::IAM::Policy'),
      );
      expect(policies).not.toContain('bedrock-agentcore');
    });

    /**
     * Exactly one action.
     *
     * When a chat request includes `memoryConfiguration`, Bedrock reads and writes the
     * conversation events itself, so the caller needs only `GetMemory` — not
     * `CreateEvent`, `ListEvents`, or `RetrieveMemoryRecords`.
     */
    it('grants only bedrock-agentcore:GetMemory, scoped to the memory ARN', () => {
      const { stack, role } = stackWith(MEMORY_ARN);
      stack.grantConversationMemory(role);

      Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'bedrock-agentcore:GetMemory',
              Effect: 'Allow',
              Resource: MEMORY_ARN,
            }),
          ]),
        }),
      });
    });

    it('grants no memory write actions', () => {
      const { stack, role } = stackWith(MEMORY_ARN);
      stack.grantConversationMemory(role);

      const policies = JSON.stringify(
        Template.fromStack(stack).findResources('AWS::IAM::Policy'),
      );

      expect(policies).not.toContain('bedrock-agentcore:*');
      for (const unnecessary of [
        'CreateEvent',
        'DeleteEvent',
        'DeleteMemory',
        'UpdateMemory',
      ]) {
        expect(policies, unnecessary).not.toContain(unnecessary);
      }
    });
  });

  describe('grantAclDiagnostics', () => {
    it('grants the two debugging actions, scoped to the knowledge base', () => {
      const app = new cdk.App();
      const stack = new AppStack(app, 'UnifiedSearch-test-App', {
        stageName: 'test',
        knowledgeBaseId: 'ABCDE12345',
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const role = new iam.Role(stack, 'Admin', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      stack.grantAclDiagnostics(role);

      const policies = JSON.stringify(
        Template.fromStack(stack).findResources('AWS::IAM::Policy'),
      );

      expect(policies).toContain('bedrock:CheckIngestedDocumentAcl');
      expect(policies).toContain('bedrock:GetIngestedDocumentAcl');
      expect(policies).toContain('knowledge-base/ABCDE12345');
    });
  });
});
