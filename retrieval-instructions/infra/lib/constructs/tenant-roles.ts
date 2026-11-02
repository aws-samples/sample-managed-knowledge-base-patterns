import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { SAMPLE_TAG_KEY, SAMPLE_TAG_VALUE, TENANT_TAG_KEY, TenantKey } from '../names';
import {
  AGENTIC_RETRIEVE_STREAM,
  INSTRUCTIONS_BY_TAG,
  LIST_INSTRUCTIONS,
  acknowledgeWildcards,
} from '../nag-acknowledgments';

/** Every retrieval instruction in the stack's account and Region. */
export function retrievalInstructionsArn(scope: Construct): string {
  return cdk.Stack.of(scope).formatArn({
    service: 'bedrock',
    resource: 'retrieval-instruction',
    resourceName: '*',
  });
}

/**
 * Trust for the sample's roles: principals of this account, limited to the one
 * principal the reader passes as trustedPrincipalArn.
 */
export function trustedPrincipal(trustedPrincipalArn: string): iam.IPrincipal {
  return new iam.AccountRootPrincipal().withConditions({
    ArnEquals: { 'aws:PrincipalArn': trustedPrincipalArn },
  });
}

export interface TenantRolesProps {
  readonly tenant: TenantKey;
  readonly trustedPrincipalArn: string;
  /** The knowledge bases this tenant may retrieve from. */
  readonly knowledgeBaseArns: readonly string[];
}

/**
 * Two roles for one tenant. The applier answers as the tenant and can apply only
 * instructions tagged with its tenant key. The tenant admin creates and manages only
 * its own tenant's instructions and can't change their sample tag.
 */
export class TenantRoles extends Construct {
  readonly applier: iam.Role;
  readonly tenantAdmin: iam.Role;

  constructor(scope: Construct, id: string, props: TenantRolesProps) {
    super(scope, id);
    const instructions = retrievalInstructionsArn(this);
    const ownTenant = { [`aws:ResourceTag/${TENANT_TAG_KEY}`]: props.tenant };

    this.applier = new iam.Role(this, 'Applier', {
      description: `Answers as tenant ${props.tenant} with that tenant's retrieval instructions`,
      assumedBy: trustedPrincipal(props.trustedPrincipalArn),
      maxSessionDuration: cdk.Duration.hours(1),
      inlinePolicies: {
        Applier: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'StreamHasNoResource',
              actions: ['bedrock:AgenticRetrieveStream'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              sid: 'RetrieveOwnKnowledgeBases',
              actions: ['bedrock:Retrieve', 'bedrock:GetDocumentContent'],
              resources: [...props.knowledgeBaseArns],
            }),
            new iam.PolicyStatement({
              sid: 'ApplyOwnTenantOnly',
              actions: ['bedrock:GetRetrievalInstruction'],
              resources: [instructions],
              conditions: { StringEquals: ownTenant },
            }),
          ],
        }),
      },
    });

    this.tenantAdmin = new iam.Role(this, 'TenantAdmin', {
      description: `Creates and manages the retrieval instructions of tenant ${props.tenant}`,
      assumedBy: trustedPrincipal(props.trustedPrincipalArn),
      maxSessionDuration: cdk.Duration.hours(1),
      inlinePolicies: {
        TenantAdmin: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'CreateOnlyForOwnTenant',
              actions: ['bedrock:CreateRetrievalInstruction'],
              resources: [instructions],
              conditions: {
                StringEquals: {
                  [`aws:RequestTag/${TENANT_TAG_KEY}`]: props.tenant,
                  [`aws:RequestTag/${SAMPLE_TAG_KEY}`]: SAMPLE_TAG_VALUE,
                },
              },
            }),
            new iam.PolicyStatement({
              sid: 'TagOnlyWhenRequestAndResourceAreOwnTenant',
              actions: ['bedrock:TagResource'],
              resources: [instructions],
              conditions: {
                StringEquals: {
                  [`aws:RequestTag/${TENANT_TAG_KEY}`]: props.tenant,
                  [`aws:ResourceTag/${TENANT_TAG_KEY}`]: props.tenant,
                },
              },
            }),
            new iam.PolicyStatement({
              sid: 'ManageOwnTenant',
              actions: [
                'bedrock:GetRetrievalInstruction',
                'bedrock:UpdateRetrievalInstruction',
                'bedrock:CreateRetrievalInstructionVersion',
                'bedrock:ListRetrievalInstructionVersions',
              ],
              resources: [instructions],
              conditions: { StringEquals: ownTenant },
            }),
            new iam.PolicyStatement({
              sid: 'ListCannotBeTagScoped',
              actions: ['bedrock:ListRetrievalInstructions'],
              resources: ['*'],
            }),
            // TagOnlyWhenRequestAndResourceAreOwnTenant constrains only the tenant key.
            // This deny keeps the sample tag, so every instruction stays in the
            // platform admin's scope and the teardown guard's. Null ... false requires
            // the key, because StringNotEquals alone is also true when it is absent.
            new iam.PolicyStatement({
              sid: 'KeepSampleAppTag',
              effect: iam.Effect.DENY,
              actions: ['bedrock:TagResource'],
              resources: [instructions],
              conditions: {
                Null: { [`aws:RequestTag/${SAMPLE_TAG_KEY}`]: 'false' },
                StringNotEquals: {
                  [`aws:RequestTag/${SAMPLE_TAG_KEY}`]: SAMPLE_TAG_VALUE,
                },
              },
            }),
          ],
        }),
      },
    });

    for (const role of [this.applier, this.tenantAdmin]) {
      cdk.Tags.of(role).add(TENANT_TAG_KEY, props.tenant);
    }
    acknowledgeWildcards(this.applier, {
      wildcards: [INSTRUCTIONS_BY_TAG],
      anyResource: AGENTIC_RETRIEVE_STREAM,
    });
    acknowledgeWildcards(this.tenantAdmin, {
      wildcards: [INSTRUCTIONS_BY_TAG],
      anyResource: LIST_INSTRUCTIONS,
    });
  }
}
