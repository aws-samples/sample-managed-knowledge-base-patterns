import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { SAMPLE_TAG_KEY, SAMPLE_TAG_VALUE, TENANT_TAG_KEY } from '../names';
import {
  INSTRUCTIONS_BY_TAG,
  LIST_INSTRUCTIONS,
  acknowledgeWildcards,
} from '../nag-acknowledgments';
import { retrievalInstructionsArn, trustedPrincipal } from './tenant-roles';

export interface PlatformAdminRoleProps {
  readonly trustedPrincipalArn: string;
}

/**
 * One per stack. Manages every tenant's instructions, scoped by the sample tag that
 * every instruction carries, so adding a tenant never touches this role.
 */
export class PlatformAdminRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: PlatformAdminRoleProps) {
    super(scope, id);
    const instructions = retrievalInstructionsArn(this);

    this.role = new iam.Role(this, 'Role', {
      description: "Manages every tenant's retrieval instructions of this sample",
      assumedBy: trustedPrincipal(props.trustedPrincipalArn),
      maxSessionDuration: cdk.Duration.hours(1),
      inlinePolicies: {
        PlatformAdmin: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'CreateOnlyAppAndTenantTagged',
              actions: ['bedrock:CreateRetrievalInstruction'],
              resources: [instructions],
              conditions: {
                StringEquals: {
                  [`aws:RequestTag/${SAMPLE_TAG_KEY}`]: SAMPLE_TAG_VALUE,
                },
                Null: { [`aws:RequestTag/${TENANT_TAG_KEY}`]: 'false' },
              },
            }),
            new iam.PolicyStatement({
              sid: 'ManageAppInstructions',
              actions: [
                'bedrock:GetRetrievalInstruction',
                'bedrock:UpdateRetrievalInstruction',
                'bedrock:CreateRetrievalInstructionVersion',
                'bedrock:ListRetrievalInstructionVersions',
                'bedrock:TagResource',
              ],
              resources: [instructions],
              conditions: {
                StringEquals: {
                  [`aws:ResourceTag/${SAMPLE_TAG_KEY}`]: SAMPLE_TAG_VALUE,
                },
                Null: { [`aws:ResourceTag/${TENANT_TAG_KEY}`]: 'false' },
              },
            }),
            new iam.PolicyStatement({
              sid: 'ListCannotBeTagScoped',
              actions: ['bedrock:ListRetrievalInstructions'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
    acknowledgeWildcards(this.role, {
      wildcards: [INSTRUCTIONS_BY_TAG],
      anyResource: LIST_INSTRUCTIONS,
    });
  }
}
