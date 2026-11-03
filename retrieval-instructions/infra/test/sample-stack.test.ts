import { describe, expect, it } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { resolveSampleOptions } from '../lib/config';
import { STACK_NAME } from '../lib/names';
import { RetrievalInstructionsSampleStack } from '../lib/sample-stack';
import { EXAMPLE_ACCOUNT, EXAMPLE_PRINCIPAL, EXAMPLE_REGION, newApp } from './support';

type Json = Record<string, unknown>;
type Statement = {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Json;
};

const INSTRUCTIONS = `arn:aws:bedrock:${EXAMPLE_REGION}:${EXAMPLE_ACCOUNT}:retrieval-instruction/*`;
const SAMPLE_TAG = { Key: 'app', Value: 'retrieval-instructions-sample' };

function synth(context: Json = {}): Template {
  // Path metadata lets the tests find resources by construct path, as the CLI writes it.
  const app = newApp({ 'aws:cdk:enable-path-metadata': true, ...context });
  const stack = new RetrievalInstructionsSampleStack(app, STACK_NAME, {
    env: { account: EXAMPLE_ACCOUNT, region: EXAMPLE_REGION },
    options: resolveSampleOptions(app.node, { account: EXAMPLE_ACCOUNT }),
  });
  return Template.fromStack(stack);
}

const OPTION_SETS: Record<string, Json> = {
  defaults: {},
  'south off': { southKnowledgeBase: false },
  'tenant roles': { trustedPrincipalArn: EXAMPLE_PRINCIPAL },
  'two tenants, south off': {
    trustedPrincipalArn: EXAMPLE_PRINCIPAL,
    tenantRoles: 'sales-region-north,sales-region-south',
    southKnowledgeBase: false,
  },
  'south tenant with south on': {
    trustedPrincipalArn: EXAMPLE_PRINCIPAL,
    tenantRoles: 'sales-region-south',
  },
};

const defaults = synth();
const withRoles = synth({ trustedPrincipalArn: EXAMPLE_PRINCIPAL });

function resourcesOf(template: Template, type: string): [string, Json][] {
  return Object.entries(template.findResources(type)) as [string, Json][];
}

function props(resource: Json): Json {
  return resource.Properties as Json;
}

/** The logical ID of the only resource of a type whose cdk path contains `path`. */
function logicalIdAt(template: Template, type: string, path: string): string {
  const matches = resourcesOf(template, type).filter(([, resource]) =>
    String((resource.Metadata as Json | undefined)?.['aws:cdk:path']).includes(path),
  );
  expect(matches).toHaveLength(1);
  return matches[0]![0];
}

function inlineStatements(template: Template, roleId: string): Statement[] {
  const role = template.toJSON().Resources[roleId] as Json;
  const policies = props(role).Policies as {
    PolicyDocument: { Statement: Statement[] };
  }[];
  return policies.flatMap((policy) => policy.PolicyDocument.Statement);
}

function policyStatementsFor(template: Template, roleId: string): Statement[] {
  return resourcesOf(template, 'AWS::IAM::Policy')
    .filter(([, policy]) =>
      (props(policy).Roles as { Ref: string }[]).some((role) => role.Ref === roleId),
    )
    .flatMap(
      ([, policy]) =>
        (props(policy).PolicyDocument as { Statement: Statement[] }).Statement,
    );
}

function actions(statement: Statement): string[] {
  return ([] as string[]).concat(statement.Action);
}

describe('knowledge bases and data sources', () => {
  it('creates two managed knowledge bases with managed embeddings and no storage', () => {
    const kbs = resourcesOf(defaults, 'AWS::Bedrock::KnowledgeBase');
    expect(kbs.map(([, kb]) => props(kb).Name).sort()).toEqual([
      'retrieval-instructions-sample-shared',
      'retrieval-instructions-sample-south',
    ]);
    for (const [, kb] of kbs) {
      expect(props(kb).KnowledgeBaseConfiguration).toEqual({
        Type: 'MANAGED',
        ManagedKnowledgeBaseConfiguration: { EmbeddingModelType: 'MANAGED' },
      });
      expect(props(kb).StorageConfiguration).toBeUndefined();
    }
  });

  it('turns ACLs off, deletes data with the data source, and indexes the right prefixes', () => {
    const prefixes: Record<string, string[]> = {};
    for (const [, ds] of resourcesOf(defaults, 'AWS::Bedrock::DataSource')) {
      const p = props(ds);
      expect(p.DataDeletionPolicy).toBe('DELETE');
      const config = p.DataSourceConfiguration as Json;
      expect(config.Type).toBe('MANAGED_KNOWLEDGE_BASE_CONNECTOR');
      const params = (config.ManagedKnowledgeBaseConnectorConfiguration as Json)
        .ConnectorParameters as Json;
      expect(params.aclEnabled).toBe(false);
      expect(params.type).toBe('S3');
      prefixes[p.Name as string] = (params.filterConfiguration as Json)
        .inclusionPrefixes as string[];
    }
    expect(prefixes).toEqual({
      'shared-corpus': ['docs/'],
      'south-corpus': ['docs/global/', 'docs/sales-region-south/'],
    });
  });

  it('removes the South knowledge base and its outputs with southKnowledgeBase=false', () => {
    const template = synth({ southKnowledgeBase: false });
    template.resourceCountIs('AWS::Bedrock::KnowledgeBase', 1);
    template.resourceCountIs('AWS::Bedrock::DataSource', 1);
    template.resourceCountIs('Custom::AWS', 1);
    const outputs = Object.keys(template.toJSON().Outputs as Json);
    expect(outputs.filter((key) => key.startsWith('South'))).toEqual([]);
  });

  it('gives each service role a scoped trust and only the explicit S3 statements', () => {
    const expected: Record<string, string[]> = {
      SharedKnowledgeBase: ['/docs/*'],
      SouthKnowledgeBase: ['/docs/global/*', '/docs/sales-region-south/*'],
    };
    for (const [construct, suffixes] of Object.entries(expected)) {
      const roleId = logicalIdAt(
        defaults,
        'AWS::IAM::Role',
        `${construct}/ServiceRole/`,
      );
      const role = defaults.toJSON().Resources[roleId] as Json;
      expect(props(role).AssumeRolePolicyDocument).toEqual({
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'bedrock.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': EXAMPLE_ACCOUNT },
              ArnLike: {
                'aws:SourceArn': `arn:aws:bedrock:${EXAMPLE_REGION}:${EXAMPLE_ACCOUNT}:knowledge-base/*`,
              },
            },
          },
        ],
      });
      const statements = policyStatementsFor(defaults, roleId);
      expect(statements.map((s) => [s.Sid, s.Action])).toEqual([
        ['ListCorpusBucket', 's3:ListBucket'],
        ['ReadCorpusObjects', 's3:GetObject'],
      ]);
      for (const statement of statements) {
        expect(statement.Condition).toEqual({
          StringEquals: { 'aws:ResourceAccount': EXAMPLE_ACCOUNT },
        });
      }
      const objectSuffixes = ([] as Json[])
        .concat(statements[1]!.Resource as Json)
        .map(
          (resource) => (resource['Fn::Join'] as [string, unknown[]])[1][1] as string,
        );
      expect(objectSuffixes).toEqual(suffixes);
      const all = statements.flatMap(actions);
      expect(all.some((action) => action.includes('*'))).toBe(false);
      expect(all.some((action) => action.startsWith('bedrock:'))).toBe(false);
    }
  });

  it('starts one ingestion job per data source with only bedrock:StartIngestionJob', () => {
    for (const construct of ['SharedKnowledgeBase', 'SouthKnowledgeBase']) {
      const kbId = logicalIdAt(
        defaults,
        'AWS::Bedrock::KnowledgeBase',
        `${construct}/Resource`,
      );
      const crId = logicalIdAt(defaults, 'Custom::AWS', `${construct}/StartIngestion/`);
      const resource = defaults.toJSON().Resources[crId] as Json;
      expect(JSON.stringify(props(resource).Create)).toContain('StartIngestionJob');
      const policyId = logicalIdAt(
        defaults,
        'AWS::IAM::Policy',
        `${construct}/StartIngestion/CustomResourcePolicy`,
      );
      const policy = defaults.toJSON().Resources[policyId] as Json;
      expect((props(policy).PolicyDocument as Json).Statement).toEqual([
        {
          Action: 'bedrock:StartIngestionJob',
          Effect: 'Allow',
          Resource: { 'Fn::GetAtt': [kbId, 'KnowledgeBaseArn'] },
        },
      ]);
    }
  });
});

describe('corpus bucket and upload', () => {
  it('blocks public access, enforces SSL, and is deleted with the stack', () => {
    defaults.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }),
    });
    defaults.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('uploads under docs/ and empties the bucket on stack deletion', () => {
    defaults.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: 'docs/',
      RetainOnDelete: Match.absent(),
      Prune: true,
    });
    defaults.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    defaults.hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([{ Key: 'aws-cdk:auto-delete-objects', Value: 'true' }]),
    });
  });
});

describe('tenant roles', () => {
  const tenantAdminId = logicalIdAt(
    withRoles,
    'AWS::IAM::Role',
    'TenantRolesSalesRegionNorth/TenantAdmin/',
  );
  const applierId = logicalIdAt(
    withRoles,
    'AWS::IAM::Role',
    'TenantRolesSalesRegionNorth/Applier/',
  );
  const platformAdminId = logicalIdAt(
    withRoles,
    'AWS::IAM::Role',
    'PlatformAdmin/Role/',
  );

  it('has no tenant role, platform admin role, or role output without trustedPrincipalArn', () => {
    for (const template of [defaults, synth({ southKnowledgeBase: false })]) {
      const roles = resourcesOf(template, 'AWS::IAM::Role').map(([id]) => id);
      expect(roles.filter((id) => /TenantRoles|PlatformAdmin/.test(id))).toEqual([]);
      const outputs = Object.keys(template.toJSON().Outputs as Json);
      expect(outputs.filter((key) => /Role/.test(key))).toEqual([]);
    }
  });

  it('trusts only the given principal, through the account root', () => {
    for (const id of [applierId, tenantAdminId, platformAdminId]) {
      const role = withRoles.toJSON().Resources[id] as Json;
      expect(props(role).AssumeRolePolicyDocument).toEqual({
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { AWS: `arn:aws:iam::${EXAMPLE_ACCOUNT}:root` },
            Condition: { ArnEquals: { 'aws:PrincipalArn': EXAMPLE_PRINCIPAL } },
          },
        ],
      });
      expect(props(role).MaxSessionDuration).toBe(3600);
    }
  });

  it('gives the applier exactly the stream, its knowledge bases, and its own instructions', () => {
    const sharedKbId = logicalIdAt(
      withRoles,
      'AWS::Bedrock::KnowledgeBase',
      'SharedKnowledgeBase/Resource',
    );
    expect(inlineStatements(withRoles, applierId)).toEqual([
      {
        Sid: 'StreamHasNoResource',
        Effect: 'Allow',
        Action: 'bedrock:AgenticRetrieveStream',
        Resource: '*',
      },
      {
        Sid: 'RetrieveOwnKnowledgeBases',
        Effect: 'Allow',
        Action: ['bedrock:GetDocumentContent', 'bedrock:Retrieve'],
        Resource: { 'Fn::GetAtt': [sharedKbId, 'KnowledgeBaseArn'] },
      },
      {
        Sid: 'ApplyOwnTenantOnly',
        Effect: 'Allow',
        Action: 'bedrock:GetRetrievalInstruction',
        Resource: INSTRUCTIONS,
        Condition: { StringEquals: { 'aws:ResourceTag/tenant': 'sales-region-north' } },
      },
    ]);
  });

  it('gives the tenant admin the own-tenant statements and the KeepSampleAppTag deny', () => {
    const own = 'sales-region-north';
    expect(inlineStatements(withRoles, tenantAdminId)).toEqual([
      {
        Sid: 'CreateOnlyForOwnTenant',
        Effect: 'Allow',
        Action: 'bedrock:CreateRetrievalInstruction',
        Resource: INSTRUCTIONS,
        Condition: {
          StringEquals: {
            'aws:RequestTag/tenant': own,
            'aws:RequestTag/app': 'retrieval-instructions-sample',
          },
        },
      },
      {
        Sid: 'TagOnlyWhenRequestAndResourceAreOwnTenant',
        Effect: 'Allow',
        Action: 'bedrock:TagResource',
        Resource: INSTRUCTIONS,
        Condition: {
          StringEquals: { 'aws:RequestTag/tenant': own, 'aws:ResourceTag/tenant': own },
        },
      },
      {
        Sid: 'ManageOwnTenant',
        Effect: 'Allow',
        Action: [
          'bedrock:CreateRetrievalInstructionVersion',
          'bedrock:GetRetrievalInstruction',
          'bedrock:ListRetrievalInstructionVersions',
          'bedrock:UpdateRetrievalInstruction',
        ],
        Resource: INSTRUCTIONS,
        Condition: { StringEquals: { 'aws:ResourceTag/tenant': own } },
      },
      {
        Sid: 'ListCannotBeTagScoped',
        Effect: 'Allow',
        Action: 'bedrock:ListRetrievalInstructions',
        Resource: '*',
      },
      {
        Sid: 'KeepSampleAppTag',
        Effect: 'Deny',
        Action: 'bedrock:TagResource',
        Resource: INSTRUCTIONS,
        Condition: {
          Null: { 'aws:RequestTag/app': 'false' },
          StringNotEquals: { 'aws:RequestTag/app': 'retrieval-instructions-sample' },
        },
      },
    ]);
  });

  it('scopes the platform admin to instructions with a tenant tag, and to no other tag', () => {
    expect(inlineStatements(withRoles, platformAdminId)).toEqual([
      {
        Sid: 'CreateOnlyTenantTagged',
        Effect: 'Allow',
        Action: 'bedrock:CreateRetrievalInstruction',
        Resource: INSTRUCTIONS,
        Condition: { Null: { 'aws:RequestTag/tenant': 'false' } },
      },
      {
        Sid: 'TagOnlyWhenRequestAndResourceAreTenantTagged',
        Effect: 'Allow',
        Action: 'bedrock:TagResource',
        Resource: INSTRUCTIONS,
        Condition: {
          Null: { 'aws:RequestTag/tenant': 'false', 'aws:ResourceTag/tenant': 'false' },
        },
      },
      {
        Sid: 'ManageTenantTagged',
        Effect: 'Allow',
        Action: [
          'bedrock:CreateRetrievalInstructionVersion',
          'bedrock:GetRetrievalInstruction',
          'bedrock:ListRetrievalInstructionVersions',
          'bedrock:UpdateRetrievalInstruction',
        ],
        Resource: INSTRUCTIONS,
        Condition: { Null: { 'aws:ResourceTag/tenant': 'false' } },
      },
      {
        Sid: 'ListCannotBeTagScoped',
        Effect: 'Allow',
        Action: 'bedrock:ListRetrievalInstructions',
        Resource: '*',
      },
    ]);
  });

  it('tags tenant roles with their tenant', () => {
    for (const id of [applierId, tenantAdminId]) {
      const role = withRoles.toJSON().Resources[id] as Json;
      expect(props(role).Tags).toEqual(
        expect.arrayContaining([
          SAMPLE_TAG,
          { Key: 'tenant', Value: 'sales-region-north' },
        ]),
      );
    }
  });

  it('creates 4 tenant roles and 1 platform admin for two tenants', () => {
    const template = synth({
      trustedPrincipalArn: EXAMPLE_PRINCIPAL,
      tenantRoles: 'sales-region-north,team-support',
    });
    const roles = resourcesOf(template, 'AWS::IAM::Role').map(([id]) => id);
    expect(roles.filter((id) => id.startsWith('TenantRoles'))).toHaveLength(4);
    expect(roles.filter((id) => id.startsWith('PlatformAdmin'))).toHaveLength(1);
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(outputs.TenantRoleTenants?.Value).toBe('sales-region-north,team-support');
    for (const tenant of ['SalesRegionNorth', 'TeamSupport']) {
      expect(outputs[`ApplierRoleArn${tenant}`]).toBeDefined();
      expect(outputs[`TenantAdminRoleArn${tenant}`]).toBeDefined();
    }
    expect(outputs.PlatformAdminRoleArn).toBeDefined();
  });

  it('lets the South applier retrieve from both knowledge bases', () => {
    const template = synth({
      trustedPrincipalArn: EXAMPLE_PRINCIPAL,
      tenantRoles: 'sales-region-south',
    });
    const applier = logicalIdAt(
      template,
      'AWS::IAM::Role',
      'TenantRolesSalesRegionSouth/Applier/',
    );
    const retrieve = inlineStatements(template, applier).find(
      (s) => s.Sid === 'RetrieveOwnKnowledgeBases',
    );
    expect(retrieve?.Resource).toHaveLength(2);
  });
});

describe('every option set', () => {
  for (const [name, context] of Object.entries(OPTION_SETS)) {
    describe(name, () => {
      const template = synth(context);
      const resources = template.toJSON().Resources as Record<string, Json>;

      it('sets no RoleName anywhere', () => {
        for (const [, role] of resourcesOf(template, 'AWS::IAM::Role')) {
          expect(props(role).RoleName).toBeUndefined();
        }
      });

      it('has outputs, none with an empty value', () => {
        const outputs = Object.values(
          template.toJSON().Outputs as Record<string, Json>,
        );
        expect(outputs.length).toBeGreaterThan(0);
        for (const output of outputs) {
          expect(output.Value).not.toBe('');
        }
      });

      it('tags every bucket, role, knowledge base, function, and log group', () => {
        const types = [
          'AWS::S3::Bucket',
          'AWS::IAM::Role',
          'AWS::Lambda::Function',
          'AWS::Logs::LogGroup',
        ];
        for (const type of types) {
          for (const [, resource] of resourcesOf(template, type)) {
            expect(props(resource).Tags).toEqual(expect.arrayContaining([SAMPLE_TAG]));
          }
        }
        for (const [, kb] of resourcesOf(template, 'AWS::Bedrock::KnowledgeBase')) {
          expect(props(kb).Tags).toEqual({ app: 'retrieval-instructions-sample' });
        }
      });

      it('logs every function to a stack log group that is deleted after every role', () => {
        const logGroups = resourcesOf(template, 'AWS::Logs::LogGroup');
        expect(logGroups.length).toBe(3);
        for (const [, group] of logGroups) {
          expect(group.DeletionPolicy).toBe('Delete');
        }
        const groupIds = logGroups.map(([id]) => id);
        for (const [, fn] of resourcesOf(template, 'AWS::Lambda::Function')) {
          const logGroup = (props(fn).LoggingConfig as Json | undefined)
            ?.LogGroup as Json;
          expect(groupIds).toContain(logGroup?.Ref);
        }
        for (const [id] of resourcesOf(template, 'AWS::IAM::Role')) {
          expect(resources[id]!.DependsOn).toEqual(expect.arrayContaining(groupIds));
        }
      });
    });
  }
});
