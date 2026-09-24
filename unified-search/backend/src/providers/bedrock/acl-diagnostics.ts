import {
  BedrockAgentRuntimeClient,
  CheckIngestedDocumentAclCommand,
  GetIngestedDocumentAclCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

import { toDomainError } from './error-mapping.js';

/**
 * Access-control debugging against a deployed knowledge base.
 *
 * Deliberately **not** wired into the HTTP API. `GetIngestedDocumentAcl` returns the
 * full allow list for a document, including other users' email addresses, and this
 * application has authentication but no authorization model — no roles, no group
 * claims. Exposing it behind authentication alone would let any signed-in user
 * enumerate who may read what.
 *
 * So it is an operator tool, invoked through `make acl-check`, and it runs with the
 * operator's own AWS credentials rather than the service's. That means access to it is
 * governed by IAM, which is the right place for an administrative capability, and there
 * is no endpoint to accidentally leave open.
 *
 * ## Why this exists at all
 *
 * ACL-aware retrieval is **fail-closed** by design: documents a user may not read are
 * left out of results. A user who should see a document and doesn't, a user who sees
 * nothing at all, an empty index, and a query that matched nothing therefore look the
 * same in a search response. These two operations query the document's ACL directly
 * to tell those cases apart.
 */

export interface AclCheckResult {
  readonly documentId: string;
  readonly userId: string;
  readonly hasAccess: boolean;
}

export interface AclPrincipal {
  readonly id: string;
  readonly type?: string;
}

export interface AclListResult {
  readonly documentId: string;
  readonly allowed: readonly AclPrincipal[];
  readonly denied: readonly AclPrincipal[];
}

export class AclDiagnostics {
  constructor(
    private readonly client: BedrockAgentRuntimeClient,
    private readonly knowledgeBaseId: string,
    private readonly dataSourceId: string,
  ) {}

  static forRegion(
    region: string,
    knowledgeBaseId: string,
    dataSourceId: string,
  ): AclDiagnostics {
    return new AclDiagnostics(
      new BedrockAgentRuntimeClient({ region }),
      knowledgeBaseId,
      dataSourceId,
    );
  }

  /**
   * Whether one user may read one document, according to the service.
   *
   * **A nonexistent `documentId` returns `false`, not an error.** The check answers
   * only the access question, so a mistyped identifier also reports "denied".
   * {@link listAcl} throws `ResourceNotFoundException` for the same input, so the CLI
   * calls both to tell the two cases apart.
   */
  async check(documentId: string, userId: string): Promise<AclCheckResult> {
    try {
      const response = await this.client.send(
        new CheckIngestedDocumentAclCommand({
          knowledgeBaseId: this.knowledgeBaseId,
          dataSourceId: this.dataSourceId,
          documentId,
          userContext: { userId },
        }),
      );
      return { documentId, userId, hasAccess: response.hasAccess ?? false };
    } catch (error) {
      throw toDomainError(error, 'CheckIngestedDocumentAcl');
    }
  }

  /**
   * The access control entries recorded for a document at ingest.
   *
   * Returns other users' identities, which is why this is an operator tool.
   */
  async listAcl(documentId: string): Promise<AclListResult> {
    try {
      const response = await this.client.send(
        new GetIngestedDocumentAclCommand({
          knowledgeBaseId: this.knowledgeBaseId,
          dataSourceId: this.dataSourceId,
          documentId,
        }),
      );

      const acl = response.documentAcl;
      return {
        documentId,
        allowed: flattenPrincipals(acl?.allowList),
        denied: flattenPrincipals(acl?.denyList),
      };
    } catch (error) {
      throw toDomainError(error, 'GetIngestedDocumentAcl');
    }
  }
}

/** Membership shape as returned: nested conditions, each carrying users and groups. */
interface Membership {
  readonly conditions?: readonly {
    readonly users?: readonly { readonly id?: string; readonly type?: string }[];
    readonly groups?: readonly { readonly id?: string; readonly type?: string }[];
  }[];
}

/**
 * Flattens the nested condition structure into a plain principal list.
 *
 * The wire shape carries `memberRelation` and `conditionOperator` for combining
 * conditions. Flattening loses that, which is acceptable for a diagnostic whose purpose
 * is "who is named here" — and {@link AclDiagnostics.check} is the authority on the
 * actual decision, so nothing depends on reconstructing the boolean logic correctly.
 */
function flattenPrincipals(membership: Membership | undefined): AclPrincipal[] {
  const principals: AclPrincipal[] = [];

  for (const condition of membership?.conditions ?? []) {
    for (const user of condition.users ?? []) {
      if (user.id !== undefined) {
        principals.push({
          id: user.id,
          ...(user.type === undefined ? {} : { type: user.type }),
        });
      }
    }
    for (const group of condition.groups ?? []) {
      if (group.id !== undefined) {
        principals.push({
          id: group.id,
          ...(group.type === undefined ? {} : { type: group.type }),
        });
      }
    }
  }

  return principals;
}
