/**
 * Configuration the Bedrock provider needs, and the token it is injected under.
 *
 * Separate from `src/config/configuration.ts` so the provider declares its own
 * requirements rather than reaching into a global shape, and so a second provider
 * would not inherit Bedrock-specific keys.
 */

export const BEDROCK_PROVIDER_CONFIG = 'BEDROCK_PROVIDER_CONFIG';

/**
 * Optional conversation memory, backed by an Amazon Bedrock AgentCore Memory
 * resource.
 *
 * Absent means chat is single-turn. That is a supported mode, not a degraded one —
 * the provider reports it through `capabilities.conversationMemory` so a UI can say
 * so instead of appearing to forget.
 */
export interface MemorySettings {
  /** An existing `ACTIVE` AgentCore Memory resource ID. */
  readonly memoryId: string;

  /**
   * Long-term memory namespace template, actor-scoped.
   *
   * Must contain the actor placeholder. A namespace shared across actors would let
   * one user's stored answers surface in another user's conversation, and memory
   * replay is **not** ACL-filtered retrieval — see {@link MEMORY_ACTOR_PLACEHOLDER}.
   */
  readonly longTermNamespace?: string;
}

/**
 * The substring an actor-scoped namespace template must contain.
 *
 * AgentCore's own namespace convention uses `{actorId}`, and requiring it here is a
 * guard rather than a formatting nicety: a namespace without it is shared by every
 * user of the deployment.
 */
export const MEMORY_ACTOR_PLACEHOLDER = '{actorId}';

export interface BedrockProviderConfig {
  readonly region: string;

  /** The managed knowledge base to retrieve from. */
  readonly knowledgeBaseId: string;

  /**
   * Number of passages to request when a caller does not specify.
   *
   * Managed reranking returns the passages it judges relevant, which can be fewer
   * than requested, so this interacts with {@link reranking} to determine result
   * counts.
   */
  readonly defaultMaxResults: number;

  /**
   * Managed reranking mode.
   *
   * `MANAGED` is the service default and generally what you want; `NONE` is useful
   * when evaluating recall, since reranking can prune below the requested count.
   */
  readonly reranking: 'MANAGED' | 'NONE';

  readonly memory?: MemorySettings;
}

/**
 * Validates provider configuration, reporting every problem at once.
 *
 * Called at module construction so a misconfigured deployment fails to start rather
 * than answering every query with an error, the same rule the authentication settings
 * follow, for the same reason.
 *
 * @throws {Error} listing all invalid values.
 */
export function validateBedrockConfig(config: BedrockProviderConfig): void {
  const problems: string[] = [];

  if (config.knowledgeBaseId.trim() === '') {
    problems.push('KNOWLEDGE_BASE_ID must be set');
  }
  if (config.region.trim() === '') {
    problems.push('AWS_REGION must be set');
  }
  if (!Number.isInteger(config.defaultMaxResults) || config.defaultMaxResults <= 0) {
    problems.push('SEARCH_DEFAULT_MAX_RESULTS must be a positive integer');
  }

  const namespace = config.memory?.longTermNamespace;
  if (namespace !== undefined && !namespace.includes(MEMORY_ACTOR_PLACEHOLDER)) {
    // Refusing to start is proportionate. A namespace missing the placeholder is
    // not a typo with a cosmetic effect: it is one shared memory partition for
    // every user, holding answers derived from access-controlled documents.
    problems.push(
      `MEMORY_LONG_TERM_NAMESPACE must contain ${MEMORY_ACTOR_PLACEHOLDER} so that ` +
        'long-term memory is scoped per user. A shared namespace would let one ' +
        "user's stored answers reach another user, bypassing document ACLs.",
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid Bedrock provider configuration: ${problems.join('; ')}. See backend/.env.example.`,
    );
  }
}
