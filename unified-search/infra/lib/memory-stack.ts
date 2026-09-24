import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

export interface MemoryStackProps extends cdk.StackProps {
  readonly stageName: string;

  /**
   * How long raw conversation events are retained, in days.
   *
   * Defaults to 30 rather than the service default of 90. This resource holds
   * generated answers derived from access-controlled documents, so retention is a
   * deliberate decision rather than something to inherit — and a sample being
   * evaluated does not need three months of history. The service permits 7 to 365.
   */
  readonly eventExpiryDays?: number;
}

/**
 * Conversation memory for multi-turn chat, backed by Amazon Bedrock AgentCore Memory.
 *
 * Deployed only in `sample` mode, and **optional even there**: without a memory
 * resource, chat is single-turn and the provider reports
 * `capabilities.conversationMemory: false` so the UI can say so rather than appear
 * to forget. The stack exists so the multi-turn path can be exercised end to end,
 * including the isolation property below.
 *
 * ## Why this holds sensitive data
 *
 * Memory stores **generated answers**, and those answers are derived from documents
 * the asking user was permitted to read. Replaying memory is **not** ACL-filtered
 * retrieval — the access-control machinery never sees it. Two consequences drive the
 * configuration here:
 *
 * 1. **Isolation is by actor, and the actor is never client-supplied.** The provider
 *    derives `sessionBinding.actorId` from the verified token's subject. Nothing in
 *    this stack can enforce that; it is enforced in
 *    `backend/src/providers/bedrock/bedrock-retrieval.provider.ts` and asserted by
 *    the integration suite, which runs two identities through the same
 *    `conversationId` and checks neither sees the other's history.
 * 2. **Encrypted with a customer-managed key.** Content derived from restricted
 *    documents is encrypted under a key this account controls, so key usage can be
 *    audited and access to it revoked independently of the memory resource.
 *
 * ## Short-term memory only
 *
 * No `memoryStrategies` are configured, so this provisions session history and not
 * long-term extraction. That is the smaller and cheaper surface, and it is what
 * multi-turn chat needs. Long-term memory would additionally require a strategy, an
 * execution role, and an actor-scoped namespace — the provider supports the last of
 * those through `MEMORY_LONG_TERM_NAMESPACE`, which it refuses to accept unless it
 * contains `{actorId}`, for the reason in point 1.
 *
 * ## Cost and teardown
 *
 * AgentCore Memory is billed separately from the knowledge base. `cdk destroy`
 * removes both the memory resource and its key. KMS schedules the key for deletion
 * with a waiting period rather than deleting it immediately, which leaves time to
 * recover it if needed.
 */
export class MemoryStack extends cdk.Stack {
  /** Pass to the backend as `MEMORY_ID`. */
  readonly memoryId: string;

  readonly memoryArn: string;

  readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: MemoryStackProps) {
    super(scope, id, props);

    const eventExpiryDays = props.eventExpiryDays ?? 30;
    if (
      !Number.isInteger(eventExpiryDays) ||
      eventExpiryDays < 7 ||
      eventExpiryDays > 365
    ) {
      // Checked at synth time so an out-of-range retention period is reported before
      // a CloudFormation update is attempted.
      throw new Error(
        `eventExpiryDays must be an integer between 7 and 365, got ${String(eventExpiryDays)}.`,
      );
    }

    const key = new kms.Key(this, 'MemoryKey', {
      description: `Encrypts conversation memory for unified-search (${props.stageName})`,
      // Content here is derived from access-controlled documents, so key rotation is
      // on and the key is not shared with anything else.
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.encryptionKey = key;

    /**
     * Lets AgentCore use the key on behalf of this account only.
     *
     * Conditioned on `aws:SourceAccount` so the service can use the key only for
     * requests on behalf of this account — the confused-deputy case, the same reason
     * the knowledge base's service role conditions its trust policy.
     */
    key.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'AllowAgentCoreMemoryUseOfTheKey',
        principals: [
          new cdk.aws_iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        ],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
    );

    // The resource policy's `Resource: '*'` means "this key", which is how KMS key
    // policies are written — they are attached to the key they govern, so there is
    // no narrower ARN to name. No cdk-nag acknowledgment is needed: AwsSolutions-KMS5
    // checks that a symmetric key has automatic rotation enabled, which it does above.

    const memory = new agentcore.CfnMemory(this, 'ConversationMemory', {
      name: `unified_search_${props.stageName}_${this.account}`,
      description: 'Short-term conversation memory for unified-search chat',
      eventExpiryDuration: eventExpiryDays,
      encryptionKeyArn: key.keyArn,
    });
    memory.node.addDependency(key);

    this.memoryId = memory.attrMemoryId;
    this.memoryArn = memory.attrMemoryArn;

    new cdk.CfnOutput(this, 'MemoryId', {
      value: memory.attrMemoryId,
      description: 'Set as MEMORY_ID on the backend to enable multi-turn chat',
    });
    new cdk.CfnOutput(this, 'MemoryArn', {
      value: memory.attrMemoryArn,
      description: 'Memory resource ARN, for IAM scoping',
    });
    new cdk.CfnOutput(this, 'MemoryKeyArn', {
      value: key.keyArn,
      description: 'Customer-managed key encrypting conversation memory',
    });
    new cdk.CfnOutput(this, 'EventExpiryDays', {
      value: String(eventExpiryDays),
      description: 'Retention for raw conversation events',
    });
  }
}
