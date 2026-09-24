import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface AppStackProps extends cdk.StackProps {
  /**
   * Short environment name, used to derive resource names.
   *
   * Resource names are derived, never fixed literals. A hardcoded table or bucket
   * name makes a second deployment into the same account and region collide, and
   * combined with `RemovalPolicy.RETAIN` it also makes redeploy-after-destroy
   * impossible.
   */
  readonly stageName: string;

  /**
   * Knowledge base the application queries.
   *
   * Supplied by the operator in `byo` mode, or by {@link KnowledgeBaseStack} in
   * `sample` mode. Either way it arrives as a plain ID: in `byo` mode the
   * knowledge base is deliberately **not** modeled as a CDK resource — not an
   * imported construct and not a custom resource — so nothing this stack does can
   * modify or delete something the operator owns.
   */
  readonly knowledgeBaseId: string;

  /**
   * Conversation memory resource, when one is deployed.
   *
   * Absent means single-turn chat, which is a supported configuration rather than a
   * degraded one. Present only in `sample` mode with `-c memory=true`.
   */
  readonly memoryArn?: string;
}

/**
 * Application infrastructure.
 *
 * Holds the knowledge base wiring and the retrieval grants, which are what the
 * `byo` and `sample` modes differ on. Compute (networking, the container service,
 * and the static site distribution) is deployment-specific and attaches to these
 * grants through {@link grantRetrieve} and {@link grantConversationMemory}.
 */
export class AppStack extends cdk.Stack {
  /** ARN of the knowledge base this deployment reads from. */
  readonly knowledgeBaseArn: string;

  /** ARN of the conversation memory resource, when one is deployed. */
  readonly memoryArn?: string;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    this.knowledgeBaseArn = this.formatArn({
      service: 'bedrock',
      resource: 'knowledge-base',
      resourceName: props.knowledgeBaseId,
    });

    if (props.memoryArn !== undefined) this.memoryArn = props.memoryArn;

    new cdk.CfnOutput(this, 'StageName', {
      value: props.stageName,
      description: 'Environment this stack was synthesized for',
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: props.knowledgeBaseId,
      description: 'Set as KNOWLEDGE_BASE_ID on the backend',
    });
  }

  /**
   * Grants read-only retrieval against this deployment's knowledge base.
   *
   * Two actions scoped to one resource ARN, plus one that cannot be scoped. A task
   * role holding `bedrock:*`, `s3:*`, and `sts:AssumeRole` on `Resource: '*'` can
   * read or delete every bucket and table in the account and assume any assumable
   * role.
   *
   * `Retrieve`, `GetDocumentContent`, and `AgenticRetrieveStream` are the only
   * Bedrock calls the application makes on the request path. Notably absent is any
   * write or management action: the application cannot start an ingestion job,
   * modify a data source, or delete the knowledge base.
   *
   * Intended for the task role of whatever runs the container.
   */
  grantRetrieve(grantee: iam.IGrantable): iam.Grant[] {
    /**
     * `bedrock:Retrieve` and `bedrock:GetDocumentContent` both support resource-level
     * permissions, so both are scoped to this knowledge base's ARN.
     *
     * They share a statement because reading document content authorizes both
     * actions: fetching a document requires `bedrock:Retrieve` on the knowledge base
     * as well as `bedrock:GetDocumentContent`. Neither needs a wildcard.
     */
    const search = iam.Grant.addToPrincipal({
      grantee,
      actions: ['bedrock:Retrieve', 'bedrock:GetDocumentContent'],
      resourceArns: [this.knowledgeBaseArn],
      scope: this,
    });

    /**
     * `bedrock:AgenticRetrieveStream` is granted on `*`.
     *
     * The action does not support resource-level permissions, so `*` is the only
     * resource it can be granted on. The grant is as narrow as the action allows:
     * exactly one action, which is read-only and streams retrieval results. It is a
     * separate statement so that the `Retrieve` grant above stays scoped to the
     * knowledge base ARN.
     *
     * `RetrieveAndGenerate` is intentionally not granted. It is not supported on a
     * managed knowledge base; chat uses `AgenticRetrieveStream` instead.
     */
    const chat = iam.Grant.addToPrincipal({
      grantee,
      actions: ['bedrock:AgenticRetrieveStream'],
      resourceArns: ['*'],
      scope: this,
    });

    return [search, chat];
  }

  /**
   * Grants use of the conversation memory resource, if one is deployed.
   *
   * Scoped to the single memory ARN. Returns nothing when memory is not configured,
   * so a deployment without it grants no memory permissions at all rather than
   * granting them against a wildcard.
   *
   * The caller needs one action, `bedrock-agentcore:GetMemory`, scoped to the memory
   * ARN. When a chat request includes `memoryConfiguration`, Bedrock reads and writes
   * the conversation events itself, so `CreateEvent`, `ListEvents`, and
   * `RetrieveMemoryRecords` are not needed on the caller's role.
   *
   * Unlike `bedrock:AgenticRetrieveStream`, this action supports resource-level
   * permissions.
   */
  grantConversationMemory(grantee: iam.IGrantable): iam.Grant | undefined {
    if (this.memoryArn === undefined) return undefined;

    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['bedrock-agentcore:GetMemory'],
      resourceArns: [this.memoryArn],
      scope: this,
    });
  }

  /**
   * Grants the access-control debugging operations.
   *
   * Separate from {@link grantRetrieve} and intended for an administrative
   * surface, not the request path. ACL-aware retrieval fails closed: a user with no
   * matching permission gets no results rather than an error. These operations let
   * an operator tell a permission misconfiguration apart from a query that matched
   * nothing. They disclose who may read a given document, so they are not granted
   * alongside ordinary retrieval.
   */
  grantAclDiagnostics(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['bedrock:CheckIngestedDocumentAcl', 'bedrock:GetIngestedDocumentAcl'],
      resourceArns: [this.knowledgeBaseArn],
      scope: this,
    });
  }
}
