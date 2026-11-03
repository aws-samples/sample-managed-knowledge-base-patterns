import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { TENANT_TAG_KEY } from '../names';
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
 * One per stack. Manages every retrieval instruction that has a `tenant` tag, the one
 * tag the post's create snippet sets, so adding a tenant never touches this role. In an
 * account that other applications share, their instructions with a `tenant` tag are in
 * scope too; SECURITY.md shows how to narrow it with another tag.
 */
export class PlatformAdminRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: PlatformAdminRoleProps) {
    super(scope, id);
    const instructions = retrievalInstructionsArn(this);
    const requestHasTenant = { [`aws:RequestTag/${TENANT_TAG_KEY}`]: 'false' };
    const resourceHasTenant = { [`aws:ResourceTag/${TENANT_TAG_KEY}`]: 'false' };

    this.role = new iam.Role(this, 'Role', {
      description: 'Manages every retrieval instruction that has a tenant tag',
      assumedBy: trustedPrincipal(props.trustedPrincipalArn),
      maxSessionDuration: cdk.Duration.hours(1),
      inlinePolicies: {
        PlatformAdmin: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: 'CreateOnlyTenantTagged',
              actions: ['bedrock:CreateRetrievalInstruction'],
              resources: [instructions],
              conditions: { Null: requestHasTenant },
            }),
            // A create with tags also needs TagResource, and this statement covers it.
            // The resource-tag condition stops the role from tagging an instruction that
            // has no tenant tag into its own scope.
            new iam.PolicyStatement({
              sid: 'TagOnlyWhenRequestAndResourceAreTenantTagged',
              actions: ['bedrock:TagResource'],
              resources: [instructions],
              conditions: { Null: { ...requestHasTenant, ...resourceHasTenant } },
            }),
            new iam.PolicyStatement({
              sid: 'ManageTenantTagged',
              actions: [
                'bedrock:GetRetrievalInstruction',
                'bedrock:UpdateRetrievalInstruction',
                'bedrock:CreateRetrievalInstructionVersion',
                'bedrock:ListRetrievalInstructionVersions',
              ],
              resources: [instructions],
              conditions: { Null: resourceHasTenant },
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
