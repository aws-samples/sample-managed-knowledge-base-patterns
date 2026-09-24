import type { SourceType } from './sources.js';

export interface SearchQuery {
  readonly text: string;

  /**
   * Maximum hits to return in this page.
   *
   * Note that fewer may come back even when more matches exist. For connectors
   * that support real-time ACL verification, Bedrock re-checks each candidate
   * against the live permission system and drops any the user has lost access
   * to, without backfilling the page. A short page therefore does not mean the
   * end of results.
   */
  readonly maxResults?: number;

  /** Opaque continuation token from a previous {@link SearchPage}. */
  readonly nextToken?: string;

  /**
   * Restrict results to these data source IDs.
   *
   * Expressed by the provider as a `managedSearchConfiguration.filter` on the
   * `_data_source_id` metadata key. The domain contract stays independent of that,
   * so the API and UI do not depend on how scoping happens to be implemented.
   */
  readonly sourceIds?: readonly string[];
}

export interface SearchHit {
  /** Provider-assigned document identifier. Stable enough to use for ACL debugging. */
  readonly id: string;

  /**
   * Data source that produced this hit.
   *
   * Surfaced as a named field rather than left in {@link metadata} because fetching a
   * document's content requires it alongside the document id, and a caller should not
   * have to know that the Bedrock API spells it `_data_source_id`. String-matching
   * service-internal attribute names inside view components is how a provider rename
   * becomes a frontend bug.
   *
   * Optional because a connector need not report one.
   */
  readonly dataSourceId?: string;

  /**
   * Human-readable document title, when one can be determined.
   *
   * Optional because it is derived rather than given: the retrieval API returns
   * document location and arbitrary metadata, not a guaranteed title field. The
   * provider derives it from metadata or the URI where possible. Callers must
   * handle its absence and fall back to the URI.
   */
  readonly title?: string;

  /** Canonical location of the source document, when the connector reports one. */
  readonly uri?: string;

  /** The matched passage text. */
  readonly snippet: string;

  /**
   * Relevance score as a number, where higher is more relevant.
   *
   * Deliberately not an enumerated confidence band. Bedrock returns a numeric
   * score, so presentation is a decision the UI has to make rather than a label
   * it can echo. Scores are relative to the result set: use them to order hits
   * within a response, not as a threshold across queries.
   */
  readonly score?: number;

  readonly sourceType: SourceType;

  /**
   * Connector-supplied document metadata, passed through unchanged.
   *
   * `unknown` values rather than `any`: metadata keys and types vary by
   * connector, so callers must narrow before use. String-matching service-internal
   * attribute names directly in view components is what this type is meant to
   * discourage.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];

  /** Present when more results are available. Absent on the final page. */
  readonly nextToken?: string;
}
