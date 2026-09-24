/**
 * Where a retrieved document came from.
 *
 * Mirrors the connector types a Bedrock managed knowledge base supports, in
 * domain vocabulary rather than the API's enum spelling. `unknown` exists for
 * forward compatibility: Bedrock can add connector types and return a location
 * variant this build has never seen, and the correct response to that is to
 * surface the result with an unrecognized source rather than to throw and lose
 * an answer the user is entitled to.
 */
export type SourceType =
  | 's3'
  | 'sharepoint'
  | 'onedrive'
  | 'confluence'
  | 'google-drive'
  | 'web'
  | 'custom'
  | 'unknown';

/**
 * Whether a data source enforces document-level access control.
 *
 * Deliberately three-valued rather than a boolean. For Bedrock managed knowledge
 * bases the data source APIs do not return the ACL setting: `aclEnabled` is set in
 * the connector configuration at deploy time, and `GetDataSource` does not include
 * that configuration. `unknown` represents that case. See DESIGN.md.
 *
 * A boolean would have forced that unknown into `false`, which reads as the
 * positive claim "this source returns documents to everyone" and would mislead an
 * operator whose ACLs are correctly configured. In the other direction, a `true`
 * inferred from configuration that does not match what is deployed would tell an
 * operator their corpus is filtered when it is not.
 *
 * Callers should treat `unknown` the same as `disabled` when deciding whether to
 * warn, and differently when explaining why.
 */
export type AclFilteringStatus =
  /** Confirmed to filter by document-level ACL. */
  | 'enabled'
  /** Confirmed not to filter. Every user receives every document from this source. */
  | 'disabled'
  /** Not reported by the provider and not configured locally. Assume unfiltered. */
  | 'unknown';

/**
 * A data source attached to the knowledge base.
 */
export interface KnowledgeSource {
  readonly id: string;
  readonly name: string;

  /**
   * Whether document-level access control is enforced on this source.
   *
   * Load-bearing rather than informational. A knowledge base may mix
   * ACL-enabled and non-ACL sources, and documents from a non-ACL source are
   * returned to **every** user regardless of the identity supplied. Surfacing
   * this lets the application tell an operator which parts of their corpus are
   * unfiltered, instead of leaving it to be discovered.
   *
   * Web-crawled content cannot support ACLs, since public web pages have no
   * permission model to crawl.
   */
  readonly aclFiltering: AclFilteringStatus;

  /**
   * Connector family, when it can be determined.
   *
   * Typically `unknown` on a managed knowledge base: the control plane reports the
   * type as `MANAGED_KNOWLEDGE_BASE_CONNECTOR` rather than naming the connector
   * family. Retrieved documents carry a source type, so a hit's
   * {@link SearchHit.sourceType} is often more specific than its data source's.
   */
  readonly type: SourceType;
}
